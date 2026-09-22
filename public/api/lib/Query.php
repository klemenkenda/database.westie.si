<?php
/**
 * Filtering, sorting and faceting over an in-memory list of records.
 *
 * Every filter is AND-ed. A filter given several comma-separated values is OR-ed within
 * itself, except `tags`, where all listed tags must be present — that is what makes the
 * cross-index ("connection" AND "blues") useful rather than merely broad.
 */
class Query
{
    /** Fields a record may be filtered on, mapped to how the value is compared. */
    private static $scalarFilters = [
        'category' => 'any', 'level' => 'any', 'kind' => 'any', 'status' => 'any',
        'course' => 'any', 'month' => 'any', 'week' => 'any', 'type' => 'any',
        'event' => 'any', 'scope' => 'any', 'taught_by_klemen' => 'bool',
    ];

    /** Fields holding a list, filtered by membership. */
    private static $listFilters = [
        'tags' => 'all', 'instructors' => 'any', 'concepts' => 'any', 'teaches' => 'any',
        'requires' => 'any', 'drills' => 'any', 'videos' => 'any', 'events' => 'any',
        'categories' => 'any', 'levels' => 'any', 'workshops' => 'any', 'sources' => 'any',
        'classes' => 'any',
    ];

    public static function apply(array $records, array $params): array
    {
        $out = [];
        foreach ($records as $key => $record) {
            if (self::matches($record, $params)) {
                $out[$key] = $record;
            }
        }
        return $out;
    }

    private static function matches(array $record, array $params): bool
    {
        foreach (self::$scalarFilters as $field => $mode) {
            if (!isset($params[$field]) || $params[$field] === '') {
                continue;
            }
            $wanted = self::values($params[$field]);
            $actual = isset($record[$field]) ? $record[$field] : null;
            if ($mode === 'bool') {
                $flag = in_array(strtolower((string) $params[$field]), ['1', 'true', 'yes'], true);
                if ((bool) $actual !== $flag) {
                    return false;
                }
                continue;
            }
            if ($actual === null || !in_array((string) $actual, $wanted, true)) {
                return false;
            }
        }
        foreach (self::$listFilters as $field => $mode) {
            if (!isset($params[$field]) || $params[$field] === '') {
                continue;
            }
            $wanted = self::values($params[$field]);
            $actual = isset($record[$field]) && is_array($record[$field]) ? $record[$field] : [];
            $actual = self::memberKeys($actual);
            $hits = array_intersect($wanted, $actual);
            if ($mode === 'all' ? count($hits) !== count($wanted) : count($hits) === 0) {
                return false;
            }
        }
        if (isset($params['q']) && $params['q'] !== '') {
            $blob = isset($record['_text']) ? $record['_text'] : '';
            foreach (preg_split('/\s+/', mb_strtolower(trim($params['q']))) as $term) {
                if ($term !== '' && mb_strpos($blob, $term) === false) {
                    return false;
                }
            }
        }
        if (isset($params['level_min']) && $params['level_min'] !== ''
            && (int) (isset($record['level']) ? $record['level'] : 0) < (int) $params['level_min']) {
            return false;
        }
        if (isset($params['level_max']) && $params['level_max'] !== ''
            && (int) (isset($record['level']) ? $record['level'] : 99) > (int) $params['level_max']) {
            return false;
        }
        return true;
    }

    private static function values($raw): array
    {
        if (is_array($raw)) {
            return array_map('strval', $raw);
        }
        return array_values(array_filter(array_map('trim', explode(',', (string) $raw)), 'strlen'));
    }

    /**
     * How much a term is worth per field it is found in. `_text` matches everything the
     * filter already required, so it says nothing about *which* hit is the good one — the
     * ranking lives entirely in where the term landed. A title hit is the strongest signal;
     * `excerpt` is last because for most records it is auto-linked workshop prose.
     */
    private static $fieldWeights = [
        'title' => 10.0, '_key' => 5.0, 'tags' => 3.0, 'excerpt' => 1.0,
    ];

    /** Between equally good hits, the curriculum outranks the raw archive it was built from. */
    private static $collectionWeights = [
        'concepts' => 1.5, 'drills' => 1.2, 'classes' => 1.2, 'plans' => 1.0,
        'videos' => 0.4, 'workshops' => 0.25, 'events' => 0.25,
    ];

    /** The query split into comparable terms. */
    private static function terms(string $q): array
    {
        return array_values(array_filter(
            preg_split('/\s+/', mb_strtolower(trim($q))), 'strlen'));
    }

    /**
     * Score one field. Whole-word beats prefix beats substring, and matching the query as a
     * contiguous phrase — best of all, matching it exactly — outweighs any of them.
     */
    private static function fieldScore(string $text, array $terms, string $phrase): float
    {
        $text = trim(mb_strtolower($text));
        if ($text === '') {
            return 0.0;
        }
        $words = preg_split('/[^\p{L}\p{N}]+/u', $text, -1, PREG_SPLIT_NO_EMPTY);
        $score = 0.0;
        if ($text === $phrase) {
            $score += 10.0;                                    // the record *is* the query
        } elseif (count($terms) > 1) {
            // Keeping the terms contiguous is only evidence when there are several of them.
            if (mb_strpos($text, $phrase) === 0) {
                $score += 2.0 * (count($terms) - 1);           // it leads with the query
            } elseif (mb_strpos($text, $phrase) !== false) {
                $score += 1.2 * (count($terms) - 1);           // the phrase, somewhere inside
            }
        }
        $hits = 0;
        $whole = 0;
        foreach ($terms as $term) {
            if (in_array($term, $words, true)) {
                $score += 1.0;
                $hits++;
                $whole++;
            } elseif (self::hasPrefix($words, $term)) {
                $score += 0.6;
                $hits++;
            } elseif (mb_strpos($text, $term) !== false) {
                $score += 0.3;
                $hits++;
            }
        }
        if ($hits === count($terms)) {
            $score += 1.5;                                     // covers every term asked for
        }
        // How much of the field the query accounts for: "Basic whip" is a better answer for
        // "whip" than "Whip - behind the back, hands above head", which merely starts with it.
        // Only for short, label-like fields — over a paragraph of prose the ratio is noise.
        if (count($words) <= 12) {
            $score += 3.0 * ($whole / count($words));
        }
        return $score;
    }

    private static function hasPrefix(array $words, string $term): bool
    {
        foreach ($words as $word) {
            if (mb_strpos($word, $term) === 0) {
                return true;
            }
        }
        return false;
    }

    /** Relevance of one record to `q`. Higher is better; 0 means "matched only in the body". */
    public static function score(array $record, array $terms, string $phrase): float
    {
        if (!$terms) {
            return 0.0;
        }
        $score = 0.0;
        foreach (self::$fieldWeights as $field => $weight) {
            $value = isset($record[$field]) ? $record[$field] : null;
            if (is_array($value)) {
                $best = 0.0;
                foreach ($value as $item) {
                    if (is_string($item)) {
                        $best = max($best, self::fieldScore($item, $terms, $phrase));
                    }
                }
                $score += $weight * $best;
            } elseif (is_string($value)) {
                $score += $weight * self::fieldScore($value, $terms, $phrase);
            }
        }
        $collection = isset($record['_collection']) ? $record['_collection'] : '';
        $score *= isset(self::$collectionWeights[$collection])
            ? self::$collectionWeights[$collection] : 1.0;
        // Between otherwise equal hits the shorter title is the more precise answer, and it
        // keeps the order from turning on incidental wording further down the record.
        $title = (string) (isset($record['title']) ? $record['title'] : '');
        if ($title !== '') {
            $score += 1.0 / (1.0 + mb_strlen($title) / 20.0);
        }
        return $score;
    }

    /**
     * Order by relevance to `q`, strongest first, falling back to title so that equally
     * relevant records still come back in a stable order.
     */
    public static function rank(array $records, string $q, string $dir = 'desc'): array
    {
        $terms = self::terms($q);
        $phrase = implode(' ', $terms);
        $scored = [];
        foreach ($records as $record) {
            $scored[] = [self::score($record, $terms, $phrase), $record];
        }
        usort($scored, function ($a, $b) {
            if ($a[0] !== $b[0]) {
                return $b[0] <=> $a[0];
            }
            $x = isset($a[1]['title']) ? $a[1]['title'] : $a[1]['_key'];
            $y = isset($b[1]['title']) ? $b[1]['title'] : $b[1]['_key'];
            return strcasecmp((string) $x, (string) $y);
        });
        $out = array_column($scored, 1);
        return strtolower($dir) === 'asc' ? array_reverse($out) : $out;
    }

    public static function sort(array $records, string $field = 'title', string $dir = 'asc'): array
    {
        $records = array_values($records);
        usort($records, function ($a, $b) use ($field) {
            $x = isset($a[$field]) ? $a[$field] : null;
            $y = isset($b[$field]) ? $b[$field] : null;
            if (is_numeric($x) && is_numeric($y)) {
                return $x <=> $y;
            }
            return strcasecmp((string) $x, (string) $y);
        });
        if (strtolower($dir) === 'desc') {
            $records = array_reverse($records);
        }
        return $records;
    }

    /** Value counts for the filter sidebar. */
    /**
     * A list field's values as strings, for membership filters.
     *
     * Most list fields hold plain keys. A plan's `classes` holds one map per membership —
     * `{class, month, week}` — and the value worth matching is the class it names, so that
     * `?classes=sugar-push` still answers "which seasons teach this".
     */
    private static function memberKeys(array $values): array
    {
        $out = [];
        foreach ($values as $value) {
            if (is_scalar($value)) {
                $out[] = (string) $value;
            } elseif (is_array($value) && isset($value['class']) && is_scalar($value['class'])) {
                $out[] = (string) $value['class'];
            }
        }
        return $out;
    }

    public static function facets(array $records, array $fields): array
    {
        $facets = [];
        foreach ($fields as $field) {
            $counts = [];
            foreach ($records as $record) {
                $value = isset($record[$field]) ? $record[$field] : null;
                if ($value === null || $value === '') {
                    continue;
                }
                foreach (is_array($value) ? $value : [$value] as $item) {
                    if ($item === null || $item === '' || is_array($item)) {
                        continue;
                    }
                    $item = (string) $item;
                    $counts[$item] = (isset($counts[$item]) ? $counts[$item] : 0) + 1;
                }
            }
            arsort($counts);
            $facets[$field] = $counts;
        }
        return $facets;
    }

    /** Drop the search blob and, when `fields` is given, everything not asked for. */
    public static function project(array $records, string $fields = ''): array
    {
        $wanted = $fields === ''
            ? null
            : array_filter(array_map('trim', explode(',', $fields)), 'strlen');
        $out = [];
        foreach ($records as $record) {
            unset($record['_text']);
            if ($wanted !== null) {
                $keep = ['_key' => $record['_key'], '_collection' => $record['_collection']];
                foreach ($wanted as $field) {
                    if (array_key_exists($field, $record)) {
                        $keep[$field] = $record[$field];
                    }
                }
                $record = $keep;
            }
            $out[] = $record;
        }
        return $out;
    }
}
