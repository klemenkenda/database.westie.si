<?php
/**
 * database.westie.si — HTTP API over a folder of Markdown files.
 *
 * Routes (all under /api):
 *   GET    /health
 *   GET    /overview                        counts, facets and the graph audit summary
 *   GET    /taxonomy
 *   GET    /search?q=                       across every collection, ranked
 *   GET    /{collection}?filters            list, filter, sort, facet, paginate
 *   GET    /{collection}/{key}              one record
 *   POST   /{collection}                    create   {key, ...frontmatter, body}
 *   PUT    /{collection}/{key}              update (frontmatter merged, null deletes a key)
 *   DELETE /{collection}/{key}
 *   GET    /concepts/{key}/graph            prerequisites, what it unlocks, trust summary
 *   GET    /audit                           the full graph audit, as written to .audit/
 *
 * Collections: concepts, videos, creators, channels, paths.
 *
 * Writes require X-Api-Token when a write token is configured. Reads never do.
 */

declare(strict_types=1);

require __DIR__ . '/lib/Yaml.php';
require __DIR__ . '/lib/Trust.php';
require __DIR__ . '/lib/Store.php';
require __DIR__ . '/lib/Query.php';
require __DIR__ . '/lib/Graph.php';
require __DIR__ . '/lib/Wsdc.php';
require __DIR__ . '/lib/Rank.php';

class ApiError extends Exception
{
    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message, $status);
    }
}

$config = require __DIR__ . '/config.php';

mb_internal_encoding('UTF-8');
header('Access-Control-Allow-Origin: ' . $config['cors_origin']);
header('Access-Control-Allow-Headers: Content-Type, X-Api-Token');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('X-Content-Type-Options: nosniff');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$store = new Store($config['content_root'], (int) $config['cache_ttl']);
$graph = new Graph($store);

/** The ranking weights. A missing or unreadable file falls back to the library defaults. */
function rankingConfig(array $config): array
{
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    $path = rtrim($config['content_root'], "/\\") . '/ranking.yml';
    $cached = is_file($path) ? Yaml::parse((string) file_get_contents($path)) : [];
    return $cached;
}

$ranking = rankingConfig($config);
$wsdc = new Wsdc($ranking);
$rank = new Rank($ranking, $wsdc);

/**
 * Attach the computed authority to a creator record.
 *
 * Computed on read rather than stored, for the same reason backlinks are: a stored score
 * goes stale the moment the weights change or the registry moves, and a stale number that
 * looks authoritative is worse than no number.
 */
function withAuthority(array $creator, Wsdc $wsdc): array
{
    $creator['_authority'] = $wsdc->score($creator);
    return $creator;
}

/** Everything after /api/ as path segments. */
function segments(): array
{
    $path = $_GET['_route'] ?? null;
    if ($path === null) {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $script = dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php');
        if ($script !== '/' && strpos($uri, $script) === 0) {
            $uri = substr($uri, strlen($script));
        }
        $path = $uri;
    }
    $path = trim((string) $path, '/');
    if ($path === '' || $path === 'index.php') {
        return [];
    }
    return array_values(array_filter(explode('/', $path), 'strlen'));
}

function jsonBody(): array
{
    $raw = (string) file_get_contents('php://input');
    if (trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        throw new ApiError('request body must be a JSON object', 400);
    }
    return $decoded;
}

function send($payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
}

/** Writes are gated when a token is configured; reads never are. */
function requireWriteToken(array $config): void
{
    $expected = (string) $config['write_token'];
    if ($expected === '') {
        return;
    }
    $given = $_SERVER['HTTP_X_API_TOKEN'] ?? '';
    if (!is_string($given) || !hash_equals($expected, $given)) {
        throw new ApiError('a valid X-Api-Token is required for writes', 401);
    }
}

try {
    $parts = segments();
    $head = $parts[0] ?? '';

    // ------------------------------------------------------------------ health
    if ($head === 'health' || $head === '') {
        $ok = is_dir($config['content_root']);
        send([
            'ok'           => $ok,
            'service'      => 'database.westie.si',
            'content_root' => $ok ? 'present' : 'missing',
            'collections'  => array_keys(Store::$collections),
            'writable'     => is_writable($config['content_root']),
            'write_token'  => $config['write_token'] !== '' ? 'required' : 'open',
            'time'         => date('c'),
        ], $ok ? 200 : 503);
        $store->flush();
        exit;
    }

    // ----------------------------------------------------------------- overview
    if ($head === 'overview') {
        $counts = [];
        foreach (array_keys(Store::$collections) as $collection) {
            $counts[$collection] = count($store->all($collection));
        }
        $audit = $graph->audit();
        send([
            'counts' => $counts,
            'graph'  => [
                'concepts'   => $audit['concepts'],
                'edges'      => $audit['edges'],
                'density'    => $audit['density'],
                'trust'      => $audit['trust'],
                'unreviewed' => $audit['unreviewed'],
                'problems'   => [
                    'cycles'     => count($audit['cycles']),
                    'dangling'   => count($audit['dangling']),
                    'inversions' => count($audit['inversions']),
                    'orphans'    => count($audit['orphans']),
                    'uncovered'  => count($audit['uncovered']),
                    'sparse'     => count($audit['sparse']),
                ],
            ],
        ]);
        $store->flush();
        exit;
    }

    // ------------------------------------------------------------------ ranking
    //
    // The ordering policy, readable over HTTP. A ranking people cannot inspect is one they
    // have to take on faith, and the whole point of putting the weights in a YAML file is
    // that the answer to "why is this above that" stays checkable.
    if ($head === 'ranking') {
        $sample = [];
        foreach ([['CHA', 2000], ['CHA', 300], ['ALS', 800], ['ADV', 400], ['INT', 200], ['NOV', 60]] as $pair) {
            list($division, $points) = $pair;
            $sample[] = [
                'division'  => $division,
                'points'    => $points,
                'authority' => $wsdc->score([
                    'wsdc_status' => Wsdc::CONFIRMED,
                    'wsdc' => ['leader' => [$division => $points]],
                ])['score'],
            ];
        }
        send([
            'weights'   => $ranking['weights'] ?? [],
            'authority' => $ranking['authority'] ?? [],
            'tiers'     => $ranking['tiers'] ?? [],
            'penalties' => $ranking['penalties'] ?? [],
            'curve'     => $sample,
            'note'      => 'Demotion is a sort tier, not a penalty: demoted material sorts '
                         . 'after everything non-demoted whatever it scores.',
        ]);
        exit;
    }

    // -------------------------------------------------------------------- audit
    if ($head === 'audit') {
        send($graph->audit());
        $store->flush();
        exit;
    }

    // ----------------------------------------------------------------- taxonomy
    if ($head === 'taxonomy') {
        $path = rtrim($config['content_root'], "/\\") . '/taxonomy.md';
        if (!is_file($path)) {
            throw new ApiError('taxonomy not found', 404);
        }
        list($front, $body) = Yaml::splitDocument((string) file_get_contents($path));
        $front['body'] = $body;
        send($front);
        exit;
    }

    // ------------------------------------------------------------------- search
    if ($head === 'search') {
        $q = trim((string) ($_GET['q'] ?? ''));
        if ($q === '') {
            throw new ApiError('search needs a q parameter', 400);
        }
        $limit = max(1, min(100, (int) ($_GET['limit'] ?? 20)));
        $hits = [];
        foreach (array_keys(Store::$collections) as $collection) {
            foreach (Query::rank($store->all($collection), $q) as $record) {
                $hits[] = $record;
            }
        }
        usort($hits, function ($a, $b) {
            return ($b['_score'] ?? 0) <=> ($a['_score'] ?? 0);
        });
        send(['q' => $q, 'total' => count($hits), 'results' => array_slice($hits, 0, $limit)]);
        $store->flush();
        exit;
    }

    // --------------------------------------------------------------- collections
    if (!Store::isCollection($head)) {
        throw new ApiError("unknown route '$head'", 404);
    }
    $collection = $head;
    $key = $parts[1] ?? null;
    $action = $parts[2] ?? null;

    if ($key === null) {
        if ($method === 'POST') {
            requireWriteToken($config);
            $payload = jsonBody();
            $newKey = (string) ($payload['key'] ?? $payload['id'] ?? '');
            if ($newKey === '') {
                throw new ApiError('a key is required to create a record', 400);
            }
            unset($payload['key']);
            $body = $payload['body'] ?? '';
            unset($payload['body']);
            if ($store->exists($collection, $newKey)) {
                throw new ApiError("$collection/$newKey already exists", 409);
            }
            send($store->save($collection, $newKey, $payload, (string) $body), 201);
            $store->flush();
            exit;
        }
        if ($method !== 'GET') {
            throw new ApiError("$method not allowed here", 405);
        }
        $records = Query::apply($store->all($collection), $_GET);
        $total = count($records);

        $q = trim((string) ($_GET['q'] ?? ''));
        $sort = (string) ($_GET['sort'] ?? ($q !== '' ? 'relevance' : 'title'));
        $dir = strtolower((string) ($_GET['dir'] ?? 'asc')) === 'desc' ? 'desc' : 'asc';
        if ($sort === 'relevance' && $q !== '') {
            $records = Query::rank($records, $q, $dir);
        } else {
            $records = Query::sort($records, $sort === 'relevance' ? 'title' : $sort, $dir);
        }

        // `total` is the size of the filtered set, not of the page — a caller paginating
        // needs to know how much it is paginating through.
        $offset = max(0, (int) ($_GET['offset'] ?? 0));
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 0;
        $records = array_values($records);
        if ($limit > 0) {
            $records = array_slice($records, $offset, min($limit, 500));
        } elseif ($offset > 0) {
            $records = array_slice($records, $offset);
        }
        if ($collection === 'creators') {
            foreach ($records as $i => $record) {
                $records[$i] = withAuthority($record, $wsdc);
            }
        }

        send([
            'collection' => $collection,
            'total'      => $total,
            'offset'     => $offset,
            'count'      => count($records),
            'results'    => $records,
        ]);
        $store->flush();
        exit;
    }

    // concepts/{key}/graph
    if ($action === 'graph') {
        if ($collection !== 'concepts') {
            throw new ApiError('only concepts have a graph view', 404);
        }
        if (!$graph->has($key)) {
            throw new ApiError("concepts/$key not found", 404);
        }
        $edges = $graph->requires($key);
        send([
            'concept'       => $key,
            'requires'      => $edges,
            'trust'         => Trust::summary($edges),
            'prerequisites' => $graph->prerequisites($key),
            'unlocks'       => $graph->unlocks($key),
            'dependents'    => $graph->dependents($key),
        ]);
        $store->flush();
        exit;
    }

    if ($method === 'GET') {
        $record = $store->get($collection, $key);
        if ($collection === 'concepts') {
            $record['requires'] = $graph->requires($key);
            $record['_unlocks'] = $graph->unlocks($key);
        }
        if ($collection === 'creators') {
            $record = withAuthority($record, $wsdc);
        }
        send($record);
        $store->flush();
        exit;
    }
    if ($method === 'PUT') {
        requireWriteToken($config);
        $payload = jsonBody();
        $body = array_key_exists('body', $payload) ? (string) $payload['body'] : null;
        unset($payload['body']);
        send($store->save($collection, $key, $payload, $body));
        $store->flush();
        exit;
    }
    if ($method === 'DELETE') {
        requireWriteToken($config);
        $store->delete($collection, $key);
        send(['deleted' => "$collection/$key"]);
        $store->flush();
        exit;
    }
    throw new ApiError("$method not allowed", 405);
} catch (ApiError $e) {
    $status = $e->getCode();
    send(['error' => $e->getMessage()], $status >= 400 && $status < 600 ? $status : 400);
} catch (Throwable $e) {
    error_log('api: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    send(['error' => 'internal error'], 500);
}
