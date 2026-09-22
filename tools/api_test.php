<?php
/**
 * API, parser and trust-model tests.
 *
 *   docker compose run --rm test
 *
 * Half of these are unit tests over the libs, half drive a live container over HTTP. The
 * ones that matter most are the trust tests: they pin down the rule that a routine
 * re-import can never cost a human's review, which is the sort of thing that works today,
 * gets refactored in six months, and fails silently forever after.
 */

declare(strict_types=1);

require __DIR__ . '/../public/api/lib/Yaml.php';
require __DIR__ . '/../public/api/lib/Trust.php';

class ApiError extends Exception
{
    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message, $status);
    }
}
require __DIR__ . '/../public/api/lib/Store.php';
require __DIR__ . '/../public/api/lib/Query.php';
require __DIR__ . '/../public/api/lib/Graph.php';

$passed = 0;
$failed = 0;
$failures = [];

function check(string $name, $actual, $expected): void
{
    global $passed, $failed, $failures;
    if ($actual === $expected) {
        $passed++;
        return;
    }
    $failed++;
    $failures[] = sprintf(
        "  %s\n      expected: %s\n      actual:   %s",
        $name,
        json_encode($expected, JSON_UNESCAPED_UNICODE),
        json_encode($actual, JSON_UNESCAPED_UNICODE)
    );
}

function ok(string $name, bool $condition): void
{
    check($name, $condition, true);
}

$base = getenv('WESTIE_API') ?: 'http://localhost/api';
$contentRoot = getenv('WESTIE_CONTENT_ROOT') ?: dirname(__DIR__) . '/content';

function api(string $method, string $path, ?array $body = null): array
{
    global $base;
    $context = ['http' => [
        'method' => $method,
        'header' => "Content-Type: application/json\r\n",
        'ignore_errors' => true,
        'timeout' => 20,
    ]];
    if ($body !== null) {
        $context['http']['content'] = json_encode($body);
    }
    $raw = @file_get_contents($base . $path, false, stream_context_create($context));
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
            $status = (int) $m[1];
        }
    }
    return ['status' => $status, 'body' => json_decode((string) $raw, true)];
}

// ------------------------------------------------------------------ Yaml round trip

$front = [
    'id' => 'test-concept',
    'level' => 3,
    'generated' => true,
    'verified_by' => null,
    'tags' => ['a', 'b'],
    'empty' => [],
    'requires' => [
        ['id' => 'anchor-step', 'trust' => 'imported', 'confidence' => 0.5],
        ['id' => 'stretch', 'trust' => 'verified', 'confidence' => 1.0],
    ],
];
$document = Yaml::document($front, "# Body\n");
list($reparsed, $body) = Yaml::splitDocument($document);
check('yaml: scalar round trip', $reparsed['id'], 'test-concept');
check('yaml: int round trip', $reparsed['level'], 3);
check('yaml: bool round trip', $reparsed['generated'], true);
check('yaml: null round trip', $reparsed['verified_by'], null);
check('yaml: inline list round trip', $reparsed['tags'], ['a', 'b']);
check('yaml: empty list round trip', $reparsed['empty'], []);
check('yaml: list-of-maps count', count($reparsed['requires']), 2);
check('yaml: list-of-maps id', $reparsed['requires'][0]['id'], 'anchor-step');
check('yaml: list-of-maps nested trust', $reparsed['requires'][1]['trust'], 'verified');
check('yaml: body preserved', trim($body), '# Body');
check('yaml: re-dump is stable', Yaml::dump($reparsed), Yaml::dump(Yaml::parse(Yaml::dump($reparsed))));

// --------------------------------------------------------------------------- Trust

$bare = Trust::edge('anchor-step', 'import:test');
check('trust: bare string becomes an edge', $bare['id'], 'anchor-step');
check('trust: bare string is never verified', $bare['trust'], Trust::IMPORTED);
check('trust: bare string starts uncertain', $bare['confidence'], 0.5);
check('trust: origin is recorded', $bare['origin'], 'import:test');
check('trust: unknown trust value falls back', Trust::edge(['id' => 'x', 'trust' => 'excellent'])['trust'], Trust::IMPORTED);
check('trust: confidence is clamped', Trust::edge(['id' => 'x', 'confidence' => 9])['confidence'], 1.0);
check('trust: negative confidence is clamped', Trust::edge(['id' => 'x', 'confidence' => -3])['confidence'], 0.0);
check('trust: edge without an id is dropped', Trust::edge(['trust' => 'verified']), null);
check('trust: unknown strength falls back', Trust::edge(['id' => 'x', 'strength' => 'vital'])['strength'], 'required');

$verified = Trust::edge(['id' => 'a', 'trust' => 'verified', 'strength' => 'usually-taught-before']);
$incoming = Trust::edge(['id' => 'a', 'trust' => 'imported', 'strength' => 'required'], 'import:new');

// The rule this whole file exists for.
list($merged, $changed) = Trust::merge($verified, $incoming);
check('merge: a re-import cannot demote a verified edge', $merged['trust'], Trust::VERIFIED);
check('merge: the human judgment survives', $merged['strength'], 'usually-taught-before');
ok('merge: the disagreement is recorded, not dropped', isset($merged['upstream']));
check('merge: upstream position is kept verbatim', $merged['upstream']['strength'], 'required');
ok('merge: a conflict counts as a change', $changed);

list($merged2, $changed2) = Trust::merge($verified, Trust::edge(['id' => 'a', 'trust' => 'imported', 'strength' => 'usually-taught-before']));
ok('merge: agreement leaves no conflict marker', !isset($merged2['upstream']));
ok('merge: agreement is not a change', !$changed2);

$importedLocal = Trust::edge(['id' => 'a', 'trust' => 'imported', 'strength' => 'required']);
$betterIncoming = Trust::edge(['id' => 'a', 'trust' => 'corroborated', 'strength' => 'required']);
list($merged3, ) = Trust::merge($importedLocal, $betterIncoming);
check('merge: better evidence wins', $merged3['trust'], Trust::CORROBORATED);
list($merged4, ) = Trust::merge(null, $incoming);
check('merge: a new edge is taken as-is', $merged4['trust'], Trust::IMPORTED);

check('trust: an imported edge never claims to be a rule', Trust::label($bare), 'Suggested — not reviewed');
check('trust: corroborated is worded as a tendency',
    Trust::label(Trust::edge(['id' => 'a', 'trust' => 'corroborated', 'strength' => 'required'])),
    'Usually taught before this');
check('trust: only a verified edge says required',
    Trust::label(Trust::edge(['id' => 'a', 'trust' => 'verified', 'strength' => 'required'])),
    'Required first');
ok('trust: a disputed edge is unusable', !Trust::usable(Trust::edge(['id' => 'a', 'trust' => 'disputed'])));
ok('trust: an imported edge is still usable', Trust::usable($bare));

// --------------------------------------------------------------------------- Store

check('store: traversal is rejected', Store::isSafeKey('../../etc/passwd'), false);
check('store: dot-dot anywhere is rejected', Store::isSafeKey('a..b'), false);
check('store: a leading dot is rejected', Store::isSafeKey('.cache'), false);
check('store: an empty key is rejected', Store::isSafeKey(''), false);
check('store: a slash is rejected', Store::isSafeKey('a/b'), false);
check('store: a leading dash is allowed', Store::isSafeKey('-OLLXFhw_8I'), true);
check('store: a normal key is allowed', Store::isSafeKey('basic-whip'), true);
check('store: collections are the five we serve',
    array_keys(Store::$collections), ['concepts', 'videos', 'creators', 'channels', 'paths']);
check('store: an unknown collection is not one', Store::isCollection('drills'), false);

$store = new Store($contentRoot, 0);
$concepts = $store->all('concepts');
ok('store: concepts were imported', count($concepts) > 100);
ok('store: a known concept is present', isset($concepts['basic-whip']));

// The privacy line, asserted rather than trusted.
$leaked = [];
foreach ($concepts as $key => $concept) {
    foreach (['sources', 'workshops', 'events'] as $forbidden) {
        if (!empty($concept[$forbidden])) {
            $leaked[] = "$key.$forbidden";
        }
    }
    $blob = $concept['_text'] ?? '';
    if (strpos($blob, 'youtu.be') !== false || strpos($blob, 'youtube.com') !== false) {
        $leaked[] = "$key.body";
    }
}
check('privacy: no workshop archive fields crossed the import', $leaked, []);

// ------------------------------------------------------------------ search hygiene
$blob = $concepts['basic-whip']['_text'] ?? '';
// The word "imported" also appears in the generated prose, which is legitimate content.
// What must never be indexed is the provenance *value*, which appears nowhere else.
ok('search: provenance values are not indexed', strpos($blob, 'import:teaching@') === false);
ok('search: edge ids are still indexed', strpos($blob, 'anchor-step') !== false);
ok('search: the concept title is indexed', strpos($blob, 'basic whip') !== false);

// --------------------------------------------------------------------------- Graph

$graph = new Graph($store);
$audit = $graph->audit();
check('graph: no cycles', count($audit['cycles']), 0);
check('graph: no dangling references', count($audit['dangling']), 0);
ok('graph: prerequisites resolve', count($graph->prerequisites('basic-whip')) > 0);
ok('graph: anchor-step is a prerequisite of the whip', (function () use ($graph) {
    foreach ($graph->prerequisites('basic-whip') as $row) {
        if ($row['id'] === 'anchor-step') { return true; }
    }
    return false;
})());
ok('graph: backlinks are computed', count($graph->dependents('anchor-step')) > 0);
ok('graph: an unknown concept has no prerequisites', $graph->prerequisites('no-such-concept') === []);

$order = $graph->topoOrder(['basic-whip', 'anchor-step', 'wcs-basic-rhythm']);
$posRhythm = array_search('wcs-basic-rhythm', $order, true);
$posAnchor = array_search('anchor-step', $order, true);
$posWhip = array_search('basic-whip', $order, true);
ok('graph: rhythm is taught before the anchor', $posRhythm < $posAnchor);
ok('graph: the anchor is taught before the whip', $posAnchor < $posWhip);
check('graph: topoOrder keeps every concept', count($order), 3);
check('graph: topoOrder ignores unknown keys', $graph->topoOrder(['nope']), []);

// The two audit implementations must agree, or the rule is not one rule.
$auditFile = rtrim($contentRoot, "/\\") . '/.audit/graph.json';
if (is_file($auditFile)) {
    $python = json_decode((string) file_get_contents($auditFile), true);
    check('audit: PHP and Python agree on concept count', $audit['concepts'], $python['concepts']);
    check('audit: PHP and Python agree on edge count', $audit['edges'], $python['edges']);
    check('audit: PHP and Python agree on cycles', count($audit['cycles']), count($python['cycles']));
    check('audit: PHP and Python agree on inversions', count($audit['inversions']), count($python['inversions']));
    check('audit: PHP and Python agree on orphans', count($audit['orphans']), count($python['orphans']));
    check('audit: PHP and Python agree on sparse', count($audit['sparse']), count($python['sparse']));
} else {
    echo "  (skipped audit cross-check: run tools/graph_check.py first)\n";
}

// ----------------------------------------------------------------------- live API

$health = api('GET', '/health');
check('http: health responds 200', $health['status'], 200);
check('http: health reports ok', $health['body']['ok'] ?? null, true);

$list = api('GET', '/concepts?limit=5');
check('http: concepts list responds', $list['status'], 200);
ok('http: concepts list is capped by limit', count($list['body']['results'] ?? []) <= 5);

$one = api('GET', '/concepts/basic-whip');
check('http: a concept can be fetched', $one['status'], 200);
check('http: edges are canonicalised on read', $one['body']['requires'][0]['trust'] ?? null, 'imported');
ok('http: the body is returned', !empty($one['body']['body']));

$graphResponse = api('GET', '/concepts/basic-whip/graph');
check('http: the graph view responds', $graphResponse['status'], 200);
ok('http: the graph view resolves prerequisites', count($graphResponse['body']['prerequisites'] ?? []) > 0);

check('http: an unknown concept is a 404', api('GET', '/concepts/no-such-concept')['status'], 404);
check('http: an unknown route is a 404', api('GET', '/nonsense')['status'], 404);
// Apache normalises the encoded slashes before PHP sees them, so this is a 404 rather
// than the 400 Store::safeKey would raise. Either way it is refused; what matters is that
// nothing above the collection directory is ever served.
$traversal = api('GET', '/concepts/..%2F..%2Fconfig');
ok('http: traversal is refused', $traversal['status'] !== 200);
ok('http: traversal leaks nothing', empty($traversal['body']['write_token']));
check('http: filtering by level works',
    array_unique(array_column(api('GET', '/concepts?level=1')['body']['results'] ?? [], 'level')), [1]);

// CRUD round trip, on a key nothing else uses.
$key = 'zz-test-' . getmypid();
$created = api('POST', '/concepts', [
    'key' => $key, 'title' => 'Test concept', 'level' => 2, 'category' => 'technique',
    'body' => "# Test\n",
]);
check('http: create responds 201', $created['status'], 201);
check('http: create sets the type', $created['body']['type'] ?? null, 'concept');
check('http: create clears the generated flag', $created['body']['generated'] ?? null, false);
check('http: creating it twice is a conflict', api('POST', '/concepts', ['key' => $key, 'title' => 'x'])['status'], 409);

$updated = api('PUT', '/concepts/' . $key, ['level' => 4, 'tags' => ['x']]);
check('http: update responds 200', $updated['status'], 200);
check('http: update applies the change', $updated['body']['level'] ?? null, 4);
check('http: update merges rather than replaces', $updated['body']['title'] ?? null, 'Test concept');

$cleared = api('PUT', '/concepts/' . $key, ['tags' => null]);
ok('http: an explicit null removes the key', !isset($cleared['body']['tags']));

check('http: delete responds 200', api('DELETE', '/concepts/' . $key)['status'], 200);
check('http: the record is gone', api('GET', '/concepts/' . $key)['status'], 404);

$search = api('GET', '/search?q=whip');
check('http: search responds', $search['status'], 200);
ok('http: search finds the whip', ($search['body']['total'] ?? 0) > 0);
check('http: search without a query is a 400', api('GET', '/search')['status'], 400);

// --------------------------------------------------------------------------- done

echo "\n";
if ($failures) {
    echo "FAILURES\n" . implode("\n", $failures) . "\n\n";
}
printf("%d passed, %d failed\n", $passed, $failed);
exit($failed === 0 ? 0 : 1);
