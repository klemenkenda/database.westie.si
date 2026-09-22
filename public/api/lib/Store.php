<?php
/**
 * The content store: one Markdown file per record, no database.
 *
 * A record's API key is its filename stem ("sugar-push"). The `id` field inside the
 * frontmatter may differ, so always address records by `_key`.
 *
 * Listing every collection means parsing thousands of files, so the frontmatter of each
 * file is cached in content/.cache/index.json keyed by path, mtime and size. A stale or
 * unwritable cache costs speed, never correctness: entries are re-read whenever mtime or
 * size moved.
 *
 * Adapted from teaching.westie.si, which has this code under test. The collection map and
 * the search blob differ; everything else is deliberately unchanged so fixes can flow
 * between the two.
 */
class Store
{
    /** @var array<string,string> collection name => directory, relative to content/ */
    public static $collections = [
        'concepts' => 'concepts',
        'videos'   => 'videos',
        'creators' => 'creators',
        'channels' => 'channels',
        'paths'    => 'paths',
    ];

    private $root;
    private $cachePath;
    private $cache = null;
    private $cacheDirty = false;

    /**
     * Collections already read during this request. Graph traversal asks for the same
     * collection many times over (resolving links, then backlinks, then their stubs), and
     * each rebuild costs two stat calls per file — thousands of them on a bind mount.
     */
    private $loaded = [];

    /**
     * Seconds the on-disk index is trusted without re-checking every file's mtime.
     *
     * Verifying a collection costs one stat per file, which is nothing on a Linux host and
     * roughly half a second per 500 files across a Docker bind mount. Writes through the
     * API drop the cache outright, so this window only ever delays picking up an edit made
     * to the Markdown behind the app's back. Set to 0 to check on every request.
     */
    private $ttl;

    public function __construct(string $contentRoot, int $cacheTtl = 5)
    {
        $this->root = rtrim($contentRoot, "/\\");
        $this->cachePath = $this->root . '/.cache/index.json';
        $this->ttl = $cacheTtl;
    }

    /** @var array<string,string> collection name => singular `type` written into frontmatter */
    public static $types = [
        'concepts' => 'concept', 'videos' => 'video', 'creators' => 'creator',
        'channels' => 'channel', 'paths' => 'path',
    ];

    public static function isCollection(string $name): bool
    {
        return isset(self::$collections[$name]);
    }

    public static function typeOf(string $collection): string
    {
        return isset(self::$types[$collection]) ? self::$types[$collection] : $collection;
    }

    public function dir(string $collection): string
    {
        if (!self::isCollection($collection)) {
            throw new ApiError("unknown collection '$collection'", 404);
        }
        return $this->root . '/' . self::$collections[$collection];
    }

    /**
     * Is this key safe to turn into a filename?
     *
     * Letters, digits, dot, dash and underscore only, never a leading dot and never "..",
     * which is what keeps `.`, `..` and content/.cache out of reach. A leading dash is
     * legal and has to be: nine YouTube ids in the archive open with one ("-OLLXFhw_8I"),
     * and a key never reaches a shell, where a leading dash would read as an option.
     */
    public static function isSafeKey($key): bool
    {
        $key = (string) $key;
        return $key !== ''
            && preg_match('/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/', $key) === 1
            && strpos($key, '..') === false;
    }

    /** Reject anything that could escape the collection directory. */
    public static function safeKey(string $key): string
    {
        $key = trim($key);
        if (!self::isSafeKey($key)) {
            throw new ApiError("invalid key '$key'", 400);
        }
        return $key;
    }

    public function path(string $collection, string $key): string
    {
        return $this->dir($collection) . '/' . self::safeKey($key) . '.md';
    }

    public function exists(string $collection, string $key): bool
    {
        return is_file($this->path($collection, $key));
    }

    // ------------------------------------------------------------------- reading

    /** Full record: frontmatter + body. */
    public function get(string $collection, string $key): array
    {
        $path = $this->path($collection, $key);
        if (!is_file($path)) {
            throw new ApiError("$collection/$key not found", 404);
        }
        list($front, $body) = Yaml::splitDocument((string) file_get_contents($path));
        $front['_key'] = $key;
        $front['_collection'] = $collection;
        $front['body'] = $body;
        $front['_mtime'] = filemtime($path);
        return $front;
    }

    /** Every record in a collection, frontmatter only (plus a search blob). */
    public function all(string $collection): array
    {
        if (isset($this->loaded[$collection])) {
            return $this->loaded[$collection];
        }
        $dir = $this->dir($collection);
        if (!is_dir($dir)) {
            return $this->loaded[$collection] = [];
        }
        $cache = $this->cache();
        $bucket = isset($cache[$collection]) ? $cache[$collection] : [];

        $checked = isset($cache['_checked'][$collection]) ? $cache['_checked'][$collection] : 0;
        if ($bucket && $this->ttl > 0 && (time() - $checked) < $this->ttl) {
            $fresh = [];
            foreach ($bucket as $key => $entry) {
                $fresh[$key] = $entry['d'];
            }
            return $this->loaded[$collection] = $fresh;
        }

        $records = [];
        foreach (scandir($dir) ?: [] as $file) {
            if (substr($file, -3) !== '.md') {
                continue;
            }
            $key = substr($file, 0, -3);
            $path = $dir . '/' . $file;
            $mtime = filemtime($path);
            $size = filesize($path);
            if (isset($bucket[$key]) && $bucket[$key]['m'] === $mtime && $bucket[$key]['s'] === $size) {
                $records[$key] = $bucket[$key]['d'];
                continue;
            }
            list($front, $body) = Yaml::splitDocument((string) file_get_contents($path));
            $front['_key'] = $key;
            $front['_collection'] = $collection;
            $front['excerpt'] = self::excerpt($body);
            $front['_text'] = self::searchBlob($front, $body);
            unset($front['body']);
            $records[$key] = $front;
            $bucket[$key] = ['m' => $mtime, 's' => $size, 'd' => $front];
            $this->cacheDirty = true;
        }
        foreach (array_keys($bucket) as $key) {     // drop deleted files from the cache
            if (!isset($records[$key])) {
                unset($bucket[$key]);
                $this->cacheDirty = true;
            }
        }
        $this->cache[$collection] = $bucket;
        $this->cache['_checked'][$collection] = time();
        $this->cacheDirty = true;
        return $this->loaded[$collection] = $records;
    }

    /**
     * Frontmatter for a named handful of records, without walking the whole collection.
     * Resolving a concept's eight videos should not cost a sweep of all 525 files.
     */
    public function pick(string $collection, array $keys): array
    {
        if (isset($this->loaded[$collection])) {
            $out = [];
            foreach ($keys as $key) {
                if (isset($this->loaded[$collection][$key])) {
                    $out[$key] = $this->loaded[$collection][$key];
                }
            }
            return $out;
        }
        $cache = $this->cache();
        $bucket = isset($cache[$collection]) ? $cache[$collection] : [];
        $dir = $this->dir($collection);
        $out = [];
        foreach (array_unique($keys) as $key) {
            if (!self::isSafeKey($key)) {
                continue;
            }
            $path = $dir . '/' . $key . '.md';
            if (!is_file($path)) {
                continue;
            }
            $mtime = filemtime($path);
            $size = filesize($path);
            if (isset($bucket[$key]) && $bucket[$key]['m'] === $mtime && $bucket[$key]['s'] === $size) {
                $out[$key] = $bucket[$key]['d'];
                continue;
            }
            list($front, $body) = Yaml::splitDocument((string) file_get_contents($path));
            $front['_key'] = $key;
            $front['_collection'] = $collection;
            $front['excerpt'] = self::excerpt($body);
            $front['_text'] = self::searchBlob($front, $body);
            unset($front['body']);
            $out[$key] = $front;
        }
        return $out;
    }

    /** Frontmatter of one record without its body — served from the cache when warm. */
    public function meta(string $collection, string $key)
    {
        $all = $this->all($collection);
        return isset($all[$key]) ? $all[$key] : null;
    }

    // ------------------------------------------------------------------- writing

    /**
     * Write a record. Frontmatter keys are merged over what is already there, so a PATCH-ish
     * update need only send what changed. Passing null for a key removes it.
     *
     * A hand-edit through the API clears `generated`, which is what stops
     * tools/seed_content.py --force from overwriting the file later.
     */
    public function save(string $collection, string $key, array $front, $body = null): array
    {
        $path = $this->path($collection, $key);
        $existing = [];
        $existingBody = '';
        if (is_file($path)) {
            list($existing, $existingBody) = Yaml::splitDocument((string) file_get_contents($path));
        }
        foreach (['_key', '_collection', '_text', '_mtime', 'excerpt', 'body'] as $internal) {
            unset($front[$internal]);
        }
        $merged = array_merge($existing, $front);
        foreach ($front as $field => $value) {
            if ($value === null) {
                unset($merged[$field]);     // an explicit null deletes the key outright
            }
        }
        $merged['id'] = isset($merged['id']) && $merged['id'] !== '' ? $merged['id'] : $key;
        $merged['type'] = isset($merged['type']) ? $merged['type'] : self::typeOf($collection);
        $merged['updated'] = date('Y-m-d');
        $merged['generated'] = false;
        $body = $body === null ? $existingBody : $body;

        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            throw new ApiError("cannot create $dir", 500);
        }
        $document = Yaml::document($merged, (string) $body);
        if (@file_put_contents($path, $document, LOCK_EX) === false) {
            throw new ApiError("cannot write $path — check filesystem permissions", 500);
        }
        $this->invalidate($collection);
        return $this->get($collection, $key);
    }

    public function delete(string $collection, string $key): void
    {
        $path = $this->path($collection, $key);
        if (!is_file($path)) {
            throw new ApiError("$collection/$key not found", 404);
        }
        if (!@unlink($path)) {
            throw new ApiError("cannot delete $path", 500);
        }
        $this->invalidate($collection);
    }

    // --------------------------------------------------------------------- cache

    private function cache(): array
    {
        if ($this->cache === null) {
            $this->cache = [];
            if (is_file($this->cachePath)) {
                $decoded = json_decode((string) file_get_contents($this->cachePath), true);
                if (is_array($decoded)) {
                    $this->cache = $decoded;
                }
            }
        }
        return $this->cache;
    }

    /** Persist the cache at the end of a request. Failure to write is not an error. */
    public function flush(): void
    {
        if (!$this->cacheDirty || $this->cache === null) {
            return;
        }
        $dir = dirname($this->cachePath);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            return;
        }
        @file_put_contents($this->cachePath, json_encode($this->cache), LOCK_EX);
        $this->cacheDirty = false;
    }

    /**
     * Force the next read of one collection to re-verify every file's mtime.
     *
     * Only the freshness timestamp is dropped, never the parsed records: rebuilding the
     * whole index from scratch means reading and parsing all ~1100 files, which is tens of
     * seconds on a bind mount. A save must not cost the next page load that.
     */
    private function invalidate(string $collection): void
    {
        unset($this->loaded[$collection]);
        $cache = $this->cache();
        unset($cache['_checked'][$collection]);
        $this->cache = $cache;
        $this->cacheDirty = true;
        $this->flush();
    }

    // --------------------------------------------------------------------- utils

    private static function excerpt(string $body): string
    {
        $text = preg_replace('/^#.*$/m', '', $body);              // headings
        // The generated lead-in ("*Technique · level 3* · prerequisites: …") only repeats the
        // frontmatter a card already shows in its chips, and crowds out the actual prose.
        $text = preg_replace('/\A\s*\*(?!\s)[^\n]*\n/', '', $text);
        $text = preg_replace('/!?\[([^\]]*)\]\([^)]*\)/', '$1', $text);   // links
        $text = preg_replace('/[*_`>#-]+/', ' ', $text);
        $text = trim(preg_replace('/\s+/', ' ', $text));
        return mb_substr($text, 0, 240);
    }

    /**
     * Provenance fields describe how we know something, not what it is about. They must
     * never reach the search blob: every imported edge carries `trust: "imported"`, so
     * indexing it would make the word "imported" match most of the database.
     */
    private static $notSearchable = [
        'origin' => 1, 'trust' => 1, 'confidence' => 1, 'source' => 1, 'strength' => 1,
        'evidence' => 1, 'verified_by' => 1, 'verified_at' => 1, 'level_trust' => 1,
        'generated' => 1, 'updated' => 1, 'added' => 1, 'status' => 1,
        'thumbnail_url' => 1, 'embed_url' => 1, 'watch_url' => 1,
    ];

    private static function searchBlob(array $front, string $body): string
    {
        $parts = [];
        foreach ($front as $field => $value) {
            if (isset(self::$notSearchable[$field])) {
                continue;
            }
            if (is_string($value)) {
                $parts[] = $value;
            } elseif (is_array($value)) {
                foreach ($value as $item) {
                    if (is_string($item)) {
                        $parts[] = $item;
                    } elseif (is_array($item)) {
                        // A structured edge: {id: "anchor-step", trust: "imported", ...}.
                        // Only the thing being pointed at is worth indexing.
                        foreach ($item as $innerKey => $inner) {
                            if (is_string($inner) && !isset(self::$notSearchable[$innerKey])) {
                                $parts[] = $inner;
                            }
                        }
                    }
                }
            }
        }
        $parts[] = mb_substr($body, 0, 2000);
        return mb_strtolower(implode(' ', $parts));
    }
}
