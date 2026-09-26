<?php
/**
 * Model-written suggestions for the graph rebuild, through OpenRouter.
 *
 * One node at a time: the builder asks "what should this node rest on, and what rests on
 * it", and this assembles everything a reader would want in front of them to answer that —
 * the node, the old concepts it replaces with their prose and their old edges, the new
 * graph so far, and the old concepts not yet placed — and asks the model.
 *
 * What comes back is a proposal and nothing more. Nothing here writes to a node: every
 * suggestion is shown in the builder with its reason and applied by a click, the same
 * rule the old-graph suggestions follow. Ids the model invents are dropped before the
 * response leaves this class, so the builder never has to render a link to nothing.
 *
 * Answers are cached by a hash of the exact prompt, under content/.cache/suggest/. Asking
 * again about an unchanged node costs nothing; any edit to the node or the graph around it
 * changes the prompt and so asks afresh.
 */
class Suggest
{
    private $store;
    private $config;

    public function __construct(Store $store, array $config)
    {
        $this->store = $store;
        $this->config = $config;
    }

    /** Edges for one new node: what it needs, what needs it, what to drop, its level. */
    public function forNode(string $key, bool $fresh = false, bool $cachedOnly = false): ?array
    {
        list($nodes, $old, $skipped) = $this->graph();
        if (!isset($nodes[$key])) {
            throw new ApiError("nodes/$key not found", 404);
        }
        $prompt = $this->prompt($key, $nodes, $old, $skipped);
        return $this->ask("edges-$key", self::SYSTEM, $prompt, $fresh, $cachedOnly, function ($parsed) use ($key, $nodes, $old) {
            return $this->normalise($key, $parsed, $nodes, $old);
        });
    }

    /**
     * Which old concepts to bring in next around one new node, and what to do with each.
     *
     * The question the builder is really asking while it works outwards from a node: of the
     * two hundred things still pending, which few belong next to this one, and are any of
     * them already covered or not worth carrying over at all.
     */
    public function candidates(string $key, bool $fresh = false, bool $cachedOnly = false): ?array
    {
        list($nodes, $old, $skipped) = $this->graph();
        if (!isset($nodes[$key])) {
            throw new ApiError("nodes/$key not found", 404);
        }
        $prompt = $this->nodeSection($key, $nodes, $old)
            . $this->graphSection($nodes)
            . $this->pendingSection($nodes, $old, $skipped, true)
            . "\nWhich pending old concepts should the teacher deal with next, around `$key`?\n";
        return $this->ask("candidates-$key", self::SYSTEM_CANDIDATES, $prompt, $fresh, $cachedOnly, function ($parsed) use ($key, $nodes, $old, $skipped) {
            return $this->normaliseCandidates($key, $parsed, $nodes, $old, $skipped);
        });
    }

    /** Where one pending old concept belongs: adopt (and connect), merge, or skip. */
    public function place(string $oldKey, bool $fresh = false, bool $cachedOnly = false): ?array
    {
        list($nodes, $old, $skipped) = $this->graph();
        if (!isset($old[$oldKey])) {
            throw new ApiError("concepts/$oldKey not found", 404);
        }
        $prompt = "# The old concept to place\n" . $this->oldSection($oldKey, $old, self::adoptedAs($nodes))
            . $this->graphSection($nodes)
            . $this->pendingSection($nodes, $old, $skipped, false)
            . "\nWhere does `$oldKey` belong in the new graph?\n";
        return $this->ask("place-$oldKey", self::SYSTEM_PLACE, $prompt, $fresh, $cachedOnly, function ($parsed) use ($oldKey, $nodes, $old) {
            return $this->normalisePlace($oldKey, $parsed, $nodes, $old);
        });
    }

    /**
     * One question to the model, cached by a hash of exactly what was asked.
     *
     * `cachedOnly` answers from the cache or returns null without calling out — what the
     * builder uses on every selection, so an answer already paid for reappears by itself
     * while a new one is only ever fetched on a click.
     */
    private function ask(string $name, string $system, string $prompt, bool $fresh, bool $cachedOnly, callable $normalise): ?array
    {
        $model = (string) ($this->config['openrouter_model'] ?? 'anthropic/claude-opus-5');
        $hash = substr(hash('sha256', $model . "\n" . $system . "\n" . $prompt), 0, 24);
        $cachePath = rtrim($this->config['content_root'], "/\\") . "/.cache/suggest/$name-$hash.json";

        if (!$fresh && is_file($cachePath)) {
            $cached = json_decode((string) file_get_contents($cachePath), true);
            if (is_array($cached)) {
                $cached['cached'] = true;
                return $cached;
            }
        }
        if ($cachedOnly) {
            // No answer for the graph exactly as it is — fall back to the latest one for this
            // subject. Working through a candidate list changes the graph with every click, and
            // an answer that vanished the moment you acted on it would be useless as a worklist.
            // The builder re-checks every row against the current graph, and says it is older.
            $latest = null;
            foreach (glob(dirname($cachePath) . "/$name-*.json") ?: [] as $file) {
                if ($latest === null || filemtime($file) > filemtime($latest)) {
                    $latest = $file;
                }
            }
            $cached = $latest ? json_decode((string) file_get_contents($latest), true) : null;
            if (is_array($cached)) {
                $cached['cached'] = true;
                $cached['stale'] = true;
                return $cached;
            }
            return null;
        }

        $apiKey = (string) ($this->config['openrouter_key'] ?? '');
        if ($apiKey === '') {
            throw new ApiError(
                'no OpenRouter key configured — set OPENROUTER_API_KEY in .env (then '
                . '`docker compose up -d api`) or openrouter_key in public/api/config.local.php',
                503
            );
        }
        $raw = $this->call($apiKey, $model, $system, $prompt);
        $parsed = self::extractJson($raw['text']);
        if ($parsed === null) {
            throw new ApiError('the model did not return JSON: ' . mb_substr($raw['text'], 0, 300), 502);
        }

        $result = $normalise($parsed);
        $result['model'] = $raw['model'] ?: $model;
        $result['usage'] = $raw['usage'];
        $result['generated'] = date('c');

        $dir = dirname($cachePath);
        if (is_dir($dir) || @mkdir($dir, 0775, true)) {
            @file_put_contents($cachePath, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        }
        $result['cached'] = false;
        return $result;
    }

    private function graph(): array
    {
        return [$this->store->all('nodes'), $this->store->all('concepts'), $this->store->all('skipped')];
    }

    // ------------------------------------------------------------------ the prompt

    const SYSTEM = <<<'TXT'
You are helping an experienced West Coast Swing teacher rebuild a concept prerequisite graph from scratch. The graph will drive learning paths: a learner is shown a concept's prerequisites before the concept itself.

An edge "A needs B" means a dancer cannot properly learn or do A without first having B. Two strengths exist:
- "required": A genuinely cannot be done without B.
- "usually-taught-before": B is conventionally taught first and helps, but A does not strictly depend on it.

Rules for good edges:
- Suggest direct prerequisites only. If A needs B and B already needs C in the new graph, do not suggest A needs C.
- Prefer fewer, correct edges over many plausible ones. Every edge you suggest will be read by the teacher, who decides.
- The old graph was imported from unreviewed drafts. Use it as evidence, not as truth: say when an old edge looks wrong, and suggest edges the old graph missed.
- Levels run 0 (foundation: things every dancer needs before any pattern), 1 beginner, 2 improver, 3 intermediate, 4 advanced. A concept should not sit below something it needs.
- Only use ids that appear in the lists you are given. A prerequisite can be a node already in the new graph, or an old concept not yet placed (the teacher would adopt it).

Answer with a single JSON object and nothing else, in exactly this shape:
{
  "level": {"value": <0-4>, "reason": "<why>"} or null if the current level is right,
  "prerequisites": [{"id": "<node or old concept id>", "strength": "required" | "usually-taught-before", "reason": "<one sentence>"}],
  "dependents": [{"id": "<node or old concept id>", "strength": "required" | "usually-taught-before", "reason": "<one sentence>"}],
  "remove": [{"id": "<id of a current prerequisite>", "reason": "<why it is wrong or redundant>"}],
  "notes": "<anything else worth the teacher's attention, or empty>"
}
TXT;

    const SHARED = <<<'TXT'
You are helping an experienced West Coast Swing teacher rebuild a concept prerequisite graph from scratch. The graph will drive learning paths: a learner is shown a concept's prerequisites before the concept itself.

An edge "A needs B" means a dancer cannot properly learn or do A without first having B. "required" means A genuinely cannot be done without B; "usually-taught-before" means B is conventionally taught first and helps, but A does not strictly depend on it. Suggest direct edges only: if A needs B and B needs C, A does not also need C.

The old graph was imported from unreviewed drafts. Many old concepts are fine; some are duplicates of each other under different names, some are routines, combos or event material rather than concepts, and many old edges and levels are guesses. Use it as evidence, not as truth.

Levels run 0 (foundation: things every dancer needs before any pattern), 1 beginner, 2 improver, 3 intermediate, 4 advanced.

Only use ids that appear in the lists you are given. Answer with a single JSON object and nothing else.
TXT;

    const SYSTEM_CANDIDATES = self::SHARED . <<<'TXT'


Task: the teacher has selected one node in the new graph and wants to know which pending old concepts to deal with next around it. Pick up to 10, most useful first. For each, say what to do:
- "adopt": bring it in as a new node, directly connected to the selected node. "relation" is "needs" if the selected node needs it (a prerequisite still missing), or "needed-by" if it needs the selected node (something built on it).
- "merge": it is the same thing as an existing node under another name, so it should be recorded as a source of that node. Give the node id in "into".
- "skip": it is not worth carrying over (a routine, a combo, a duplicate of another pending concept, not a concept at all). Say why.

Prefer candidates whose connection to the selected node is direct and certain. Do not list concepts that only relate through something else.

Shape:
{
  "candidates": [{"id": "<pending old concept id>", "action": "adopt" | "merge" | "skip", "relation": "needs" | "needed-by" | null, "into": "<node id, for merge>" | null, "strength": "required" | "usually-taught-before", "reason": "<one sentence>"}],
  "notes": "<anything else worth the teacher's attention, or empty>"
}
TXT;

    const SYSTEM_PLACE = self::SHARED . <<<'TXT'


Task: the teacher has selected one pending old concept and wants to know where it belongs in the new graph. Recommend exactly one action:
- "adopt": it becomes its own node. Give its level, what it needs, and what already in the new graph needs it. "needs" and "needed_by" may name existing nodes, or pending old concepts that would have to be adopted too.
- "merge": it is the same thing as an existing node under another name. Give the node id in "into".
- "skip": it should not be carried over. Say why.

Shape:
{
  "action": "adopt" | "merge" | "skip",
  "into": "<node id, for merge>" | null,
  "level": <0-4, for adopt> | null,
  "needs": [{"id": "<node or pending old concept id>", "strength": "required" | "usually-taught-before", "reason": "<one sentence>"}],
  "needed_by": [{"id": "<node id>", "strength": "required" | "usually-taught-before", "reason": "<one sentence>"}],
  "reason": "<why this action, two sentences at most>",
  "notes": "<anything else worth the teacher's attention, or empty>"
}
TXT;

    private function prompt(string $key, array $nodes, array $old, array $skipped): string
    {
        return $this->nodeSection($key, $nodes, $old)
            . $this->graphSection($nodes)
            . $this->pendingSection($nodes, $old, $skipped, false)
            . "\nSuggest what `$key` should need and what should need it.\n";
    }

    /** One new node, and what the old graph said about each concept it replaces. */
    private function nodeSection(string $key, array $nodes, array $old): string
    {
        $node = $nodes[$key];
        $body = trim($this->store->get('nodes', $key)['body'] ?? '');
        $from = array_values(array_filter((array) ($node['from'] ?? []), 'is_string'));
        $adoptedAs = self::adoptedAs($nodes);

        $out = "# The selected node\n\n";
        $out .= "id: $key\ntitle: " . ($node['title'] ?? $key) . "\nlevel: " . self::lv($node['level'] ?? null) . "\n";
        $out .= 'needs now: ' . (self::ids($node['requires'] ?? []) ?: 'nothing') . "\n";
        $dependents = [];
        foreach ($nodes as $k => $n) {
            if (in_array($key, self::idList($n['requires'] ?? []), true)) {
                $dependents[] = $k;
            }
        }
        $out .= 'needed by now: ' . ($dependents ? implode(', ', $dependents) : 'nothing') . "\n";
        if ($body !== '') {
            $out .= "description: $body\n";
        }

        if ($from) {
            $out .= "\n# What the old graph said about it\n";
            foreach ($from as $f) {
                if (isset($old[$f])) {
                    $out .= $this->oldSection($f, $old, $adoptedAs);
                }
            }
        } else {
            $out .= "\nThis node is new: the old graph had no equivalent.\n";
        }
        return $out;
    }

    /** One old concept: its prose, and its old edges with where each one landed. */
    private function oldSection(string $f, array $old, array $adoptedAs): string
    {
        $c = $old[$f];
        $oldBody = '';
        try {
            $oldBody = self::cleanOldBody((string) ($this->store->get('concepts', $f)['body'] ?? ''));
        } catch (Throwable $e) {
            // A missing body is not worth failing the whole request over.
        }
        $out = "\n## old concept $f — " . ($c['title'] ?? $f) . ' (old level ' . self::lv($c['level'] ?? null) . ")\n";
        if (!empty($c['aliases']) && is_array($c['aliases'])) {
            $out .= 'also called: ' . implode(', ', array_filter($c['aliases'], 'is_string')) . "\n";
        }
        if ($oldBody !== '') {
            $out .= "$oldBody\n";
        }
        $out .= 'old prerequisites: ' . (self::describeOld(self::idList($c['requires'] ?? []), $old, $adoptedAs) ?: 'none') . "\n";
        $oldDeps = [];
        foreach ($old as $k => $o) {
            if (in_array($f, self::idList($o['requires'] ?? []), true)) {
                $oldDeps[] = $k;
            }
        }
        $out .= 'old dependents: ' . (self::describeOld($oldDeps, $old, $adoptedAs) ?: 'none') . "\n";
        return $out;
    }

    /**
     * The new graph so far. Carries the titles of the old concepts each node replaces,
     * because "is this the same thing as a node we already have" cannot be answered from a
     * node's own title alone once a few concepts have been merged into it.
     */
    private function graphSection(array $nodes): string
    {
        $old = $this->store->all('concepts');
        $out = "\n# The new graph so far (id | title | level | needs | replaces)\n";
        if (!$nodes) {
            return $out . "(empty)\n";
        }
        ksort($nodes);
        foreach ($nodes as $k => $n) {
            $from = array_map(function ($f) use ($old) {
                return $old[$f]['title'] ?? $f;
            }, array_filter((array) ($n['from'] ?? []), 'is_string'));
            $out .= "$k | " . ($n['title'] ?? $k) . ' | ' . self::lv($n['level'] ?? null) . ' | '
                . (self::ids($n['requires'] ?? []) ?: '-') . ' | ' . ($from ? implode('; ', $from) : 'new') . "\n";
        }
        return $out;
    }

    /** The old concepts still undecided, optionally with their old prerequisites as evidence. */
    private function pendingSection(array $nodes, array $old, array $skipped, bool $withEdges): string
    {
        $adoptedAs = self::adoptedAs($nodes);
        $out = $withEdges
            ? "\n# Old concepts not yet placed (id | title | old level | old prerequisites)\n"
            : "\n# Old concepts not yet placed (id | title | old level)\n";
        ksort($old);
        foreach ($old as $k => $c) {
            if (isset($adoptedAs[$k]) || isset($skipped[$k])) {
                continue;
            }
            $out .= "$k | " . ($c['title'] ?? $k) . ' | ' . self::lv($c['level'] ?? null);
            if ($withEdges) {
                $out .= ' | ' . (self::ids($c['requires'] ?? []) ?: '-');
            }
            $out .= "\n";
        }
        return $out;
    }

    private static function adoptedAs(array $nodes): array
    {
        $out = [];
        foreach ($nodes as $k => $n) {
            foreach ((array) ($n['from'] ?? []) as $f) {
                if (is_string($f)) {
                    $out[$f] = $k;
                }
            }
        }
        return $out;
    }

    // ------------------------------------------------------------------ the call

    private function call(string $apiKey, string $model, string $system, string $prompt): array
    {
        @set_time_limit(300);
        $payload = [
            'model'      => $model,
            'max_tokens' => 16000,
            'messages'   => [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => $prompt],
            ],
        ];
        $ch = curl_init('https://openrouter.ai/api/v1/chat/completions');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 280,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $apiKey,
                'Content-Type: application/json',
                'X-Title: database.westie.si graph builder',
            ],
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        ]);
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            throw new ApiError("could not reach OpenRouter: $error", 502);
        }
        $body = json_decode((string) $response, true);
        if ($status >= 400 || !is_array($body)) {
            $message = is_array($body) ? ($body['error']['message'] ?? json_encode($body['error'] ?? $body)) : mb_substr((string) $response, 0, 300);
            throw new ApiError("OpenRouter answered $status: $message", 502);
        }
        $choice = $body['choices'][0] ?? [];
        $text = $choice['message']['content'] ?? '';
        if (is_array($text)) {        // some providers return content parts
            $text = implode('', array_map(function ($p) {
                return is_array($p) ? (string) ($p['text'] ?? '') : (string) $p;
            }, $text));
        }
        if (($choice['finish_reason'] ?? '') === 'length') {
            throw new ApiError('the model ran out of output tokens before finishing', 502);
        }
        return [
            'text'  => (string) $text,
            'model' => (string) ($body['model'] ?? ''),
            'usage' => $body['usage'] ?? null,
        ];
    }

    // ------------------------------------------------------------------ the answer

    /**
     * Keep only what the builder can act on: ids that exist, strengths it knows, a level
     * in range. Each id is resolved to what the builder should do with it — link a node,
     * or adopt an old concept and link that.
     */
    private function normalise(string $key, array $parsed, array $nodes, array $old): array
    {
        $adoptedAs = [];
        foreach ($nodes as $k => $n) {
            foreach ((array) ($n['from'] ?? []) as $f) {
                if (is_string($f)) {
                    $adoptedAs[$f] = $k;
                }
            }
        }
        $dropped = [];
        $resolve = function ($item) use ($key, $nodes, $old, $adoptedAs, &$dropped) {
            if (!is_array($item) || !is_string($item['id'] ?? null)) {
                return null;
            }
            $id = $item['id'];
            $reason = trim((string) ($item['reason'] ?? ''));
            $strength = ($item['strength'] ?? '') === 'usually-taught-before' ? 'usually-taught-before' : 'required';
            if (isset($nodes[$id])) {
                $target = ['kind' => 'node', 'id' => $id];
            } elseif (isset($adoptedAs[$id])) {
                $target = ['kind' => 'node', 'id' => $adoptedAs[$id], 'via' => $id];
            } elseif (isset($old[$id])) {
                $target = ['kind' => 'old', 'id' => $id];
            } else {
                $dropped[] = $id;
                return null;
            }
            if ($target['kind'] === 'node' && $target['id'] === $key) {
                return null;
            }
            return $target + ['strength' => $strength, 'reason' => $reason];
        };

        $list = function ($items) use ($resolve) {
            $out = [];
            $seen = [];
            foreach (is_array($items) ? $items : [] as $item) {
                $r = $resolve($item);
                if ($r && !isset($seen[$r['kind'] . ':' . $r['id']])) {
                    $seen[$r['kind'] . ':' . $r['id']] = true;
                    $out[] = $r;
                }
            }
            return $out;
        };

        $current = self::idList($nodes[$key]['requires'] ?? []);
        $remove = [];
        foreach (is_array($parsed['remove'] ?? null) ? $parsed['remove'] : [] as $item) {
            if (is_array($item) && in_array($item['id'] ?? null, $current, true)) {
                $remove[] = ['id' => $item['id'], 'reason' => trim((string) ($item['reason'] ?? ''))];
            }
        }

        $level = null;
        if (is_array($parsed['level'] ?? null) && is_numeric($parsed['level']['value'] ?? null)) {
            $v = (int) $parsed['level']['value'];
            if ($v >= 0 && $v <= 4 && $v !== ($nodes[$key]['level'] ?? null)) {
                $level = ['value' => $v, 'reason' => trim((string) ($parsed['level']['reason'] ?? ''))];
            }
        }

        return [
            'node'          => $key,
            'level'         => $level,
            'prerequisites' => $list($parsed['prerequisites'] ?? []),
            'dependents'    => $list($parsed['dependents'] ?? []),
            'remove'        => $remove,
            'notes'         => trim((string) ($parsed['notes'] ?? '')),
            'dropped'       => array_values(array_unique($dropped)),
        ];
    }

    /**
     * Candidates the builder can act on: pending old concepts only (one already adopted or
     * skipped is not a candidate for anything), a merge target that exists, an adopt with a
     * direction. Anything else is dropped rather than shown as a button that cannot work.
     */
    private function normaliseCandidates(string $key, array $parsed, array $nodes, array $old, array $skipped): array
    {
        $adoptedAs = self::adoptedAs($nodes);
        $out = [];
        $dropped = [];
        $seen = [];
        foreach (is_array($parsed['candidates'] ?? null) ? $parsed['candidates'] : [] as $c) {
            $id = is_array($c) && is_string($c['id'] ?? null) ? $c['id'] : null;
            if ($id === null || isset($seen[$id])) {
                continue;
            }
            if (!isset($old[$id]) || isset($adoptedAs[$id]) || isset($skipped[$id])) {
                $dropped[] = $id;
                continue;
            }
            $action = in_array($c['action'] ?? '', ['adopt', 'merge', 'skip'], true) ? $c['action'] : null;
            $relation = in_array($c['relation'] ?? '', ['needs', 'needed-by'], true) ? $c['relation'] : null;
            $into = is_string($c['into'] ?? null) && isset($nodes[$c['into']]) ? $c['into'] : null;
            if ($action === null || ($action === 'adopt' && $relation === null) || ($action === 'merge' && $into === null)) {
                $dropped[] = $id;
                continue;
            }
            $seen[$id] = true;
            $out[] = [
                'id'       => $id,
                'action'   => $action,
                'relation' => $action === 'adopt' ? $relation : null,
                'into'     => $action === 'merge' ? $into : null,
                'strength' => ($c['strength'] ?? '') === 'usually-taught-before' ? 'usually-taught-before' : 'required',
                'reason'   => trim((string) ($c['reason'] ?? '')),
            ];
        }
        return [
            'node'       => $key,
            'candidates' => $out,
            'notes'      => trim((string) ($parsed['notes'] ?? '')),
            'dropped'    => array_values(array_unique($dropped)),
        ];
    }

    /**
     * A placement the builder can apply in one click. `needs` may name pending old concepts
     * — shown, so the teacher knows what else is missing, but not wired, since they do not
     * exist yet. `needed_by` is nodes only: an edge from something that does not exist yet
     * has no file to be written into.
     */
    private function normalisePlace(string $oldKey, array $parsed, array $nodes, array $old): array
    {
        $adoptedAs = self::adoptedAs($nodes);
        $dropped = [];
        $action = in_array($parsed['action'] ?? '', ['adopt', 'merge', 'skip'], true) ? $parsed['action'] : 'adopt';
        $into = is_string($parsed['into'] ?? null) && isset($nodes[$parsed['into']]) ? $parsed['into'] : null;
        if ($action === 'merge' && $into === null) {
            $dropped[] = (string) ($parsed['into'] ?? '');
            $action = 'adopt';
        }

        $edges = function ($items, bool $allowOld) use ($oldKey, $nodes, $old, $adoptedAs, &$dropped) {
            $out = [];
            $seen = [];
            foreach (is_array($items) ? $items : [] as $e) {
                $id = is_array($e) && is_string($e['id'] ?? null) ? $e['id'] : null;
                if ($id === null || $id === $oldKey) {
                    continue;
                }
                if (isset($nodes[$id])) {
                    $t = ['kind' => 'node', 'id' => $id];
                } elseif (isset($adoptedAs[$id])) {
                    $t = ['kind' => 'node', 'id' => $adoptedAs[$id], 'via' => $id];
                } elseif ($allowOld && isset($old[$id])) {
                    $t = ['kind' => 'old', 'id' => $id];
                } else {
                    $dropped[] = $id;
                    continue;
                }
                if (isset($seen[$t['kind'] . ':' . $t['id']])) {
                    continue;
                }
                $seen[$t['kind'] . ':' . $t['id']] = true;
                $out[] = $t + [
                    'strength' => ($e['strength'] ?? '') === 'usually-taught-before' ? 'usually-taught-before' : 'required',
                    'reason'   => trim((string) ($e['reason'] ?? '')),
                ];
            }
            return $out;
        };

        $level = is_numeric($parsed['level'] ?? null) ? (int) $parsed['level'] : null;
        return [
            'concept'   => $oldKey,
            'action'    => $action,
            'into'      => $action === 'merge' ? $into : null,
            'level'     => $action === 'adopt' && $level !== null && $level >= 0 && $level <= 4 ? $level : null,
            'needs'     => $action === 'adopt' ? $edges($parsed['needs'] ?? [], true) : [],
            'needed_by' => $action === 'adopt' ? $edges($parsed['needed_by'] ?? [], false) : [],
            'reason'    => trim((string) ($parsed['reason'] ?? '')),
            'notes'     => trim((string) ($parsed['notes'] ?? '')),
            'dropped'   => array_values(array_unique(array_filter($dropped))),
        ];
    }

    /** The first JSON object in the text, tolerating a fence or a sentence around it. */
    public static function extractJson(string $text)
    {
        $text = trim($text);
        $decoded = json_decode($text, true);
        if (is_array($decoded)) {
            return $decoded;
        }
        $start = strpos($text, '{');
        $end = strrpos($text, '}');
        if ($start === false || $end === false || $end <= $start) {
            return null;
        }
        $decoded = json_decode(substr($text, $start, $end - $start + 1), true);
        return is_array($decoded) ? $decoded : null;
    }

    // ------------------------------------------------------------------ helpers

    private static function idList($requires): array
    {
        $out = [];
        foreach (is_array($requires) ? $requires : [] as $e) {
            if (is_string($e)) {
                $out[] = $e;
            } elseif (is_array($e) && is_string($e['id'] ?? null)) {
                $out[] = $e['id'];
            }
        }
        return $out;
    }

    private static function ids($requires): string
    {
        return implode(', ', self::idList($requires));
    }

    private static function lv($level): string
    {
        return is_numeric($level) ? (string) $level : '?';
    }

    private static function describeOld(array $ids, array $old, array $adoptedAs): string
    {
        $parts = [];
        foreach ($ids as $id) {
            if (!isset($old[$id])) {
                continue;
            }
            $parts[] = "$id (" . ($old[$id]['title'] ?? $id) . ', L' . self::lv($old[$id]['level'] ?? null)
                . (isset($adoptedAs[$id]) ? ', now node ' . $adoptedAs[$id] : '') . ')';
        }
        return implode('; ', $parts);
    }

    /** Same cleanup the builder does: drop the importer's heading and lead-in line. */
    private static function cleanOldBody(string $body): string
    {
        $lines = explode("\n", str_replace("\r\n", "\n", $body));
        $keep = array_filter($lines, function ($line) {
            return !preg_match('/^#\s/', $line) && !preg_match('/^\*[^*]+\*\s+—\s+imported/u', $line);
        });
        return trim(implode("\n", $keep));
    }
}
