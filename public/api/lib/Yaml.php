<?php
/**
 * A deliberately small YAML subset — enough for Markdown frontmatter, and nothing more.
 *
 * Supported:
 *   key: "quoted"      key: bare      key: 12      key: true      key: null
 *   key: [a, b, "c"]                       inline sequence of scalars
 *   key:                                   block sequence
 *     - one
 *     - two
 *   key:                                   block mapping
 *     a: 1
 *   key:                                   block sequence of mappings
 *     - a: 1
 *       b: 2
 *
 * Not supported, on purpose: anchors, multi-line scalars, tags, flow mappings, multiple
 * documents. Anything unrecognised is kept as a bare string rather than throwing, so a
 * hand-edited file degrades into a readable value instead of a 500.
 *
 * PHP 7.4+.
 */
class Yaml
{
    /** Split "---\nfrontmatter\n---\nbody" into [array $data, string $body]. */
    public static function splitDocument(string $raw): array
    {
        $raw = preg_replace('/^\xEF\xBB\xBF/', '', $raw);   // strip UTF-8 BOM
        $raw = str_replace("\r\n", "\n", $raw);
        if (strncmp($raw, "---\n", 4) !== 0) {
            return [[], $raw];
        }
        $end = strpos($raw, "\n---", 3);
        if ($end === false) {
            return [[], $raw];
        }
        $front = substr($raw, 4, $end - 4);
        $body = substr($raw, $end + 4);
        $body = preg_replace('/^[ \t]*\n/', '', ltrim($body, "-"));
        return [self::parse($front), ltrim($body, "\n")];
    }

    /** Parse a block of YAML into a PHP array. */
    public static function parse(string $text): array
    {
        $lines = [];
        foreach (explode("\n", str_replace("\r\n", "\n", $text)) as $line) {
            if (trim($line) === '' || preg_match('/^\s*#/', $line)) {
                continue;
            }
            $expanded = str_replace("\t", '    ', $line);
            $indent = strlen($expanded) - strlen(ltrim($expanded, ' '));
            $text = self::stripComment(rtrim(ltrim($expanded, ' ')));
            if ($text === '') {
                continue;               // the line held nothing but a comment
            }
            $lines[] = ['indent' => $indent, 'text' => $text];
        }
        $i = 0;
        $result = self::parseBlock($lines, $i, 0);
        return is_array($result) ? $result : [];
    }

    /** @param array $lines @param int $i cursor, by reference */
    private static function parseBlock(array &$lines, int &$i, int $indent)
    {
        if ($i >= count($lines)) {
            return [];
        }
        if (strncmp($lines[$i]['text'], '- ', 2) === 0 || $lines[$i]['text'] === '-') {
            return self::parseSequence($lines, $i, $indent);
        }
        return self::parseMapping($lines, $i, $indent);
    }

    private static function parseMapping(array &$lines, int &$i, int $indent): array
    {
        $map = [];
        $count = count($lines);
        while ($i < $count && $lines[$i]['indent'] >= $indent) {
            if ($lines[$i]['indent'] > $indent) {  // stray over-indent: treat as this level
                $lines[$i]['indent'] = $indent;
            }
            $text = $lines[$i]['text'];
            if (strncmp($text, '- ', 2) === 0) {
                break;
            }
            $colon = self::findKeyColon($text);
            if ($colon === false) {
                $i++;
                continue;
            }
            $key = trim(substr($text, 0, $colon));
            $rest = trim(substr($text, $colon + 1));
            $i++;
            if ($rest !== '') {
                $map[$key] = self::parseScalar($rest);
                continue;
            }
            if ($i < $count && $lines[$i]['indent'] > $indent) {
                $map[$key] = self::parseBlock($lines, $i, $lines[$i]['indent']);
            } else {
                $map[$key] = null;
            }
        }
        return $map;
    }

    private static function parseSequence(array &$lines, int &$i, int $indent): array
    {
        $seq = [];
        $count = count($lines);
        while ($i < $count && $lines[$i]['indent'] === $indent
               && strncmp($lines[$i]['text'], '-', 1) === 0) {
            $rest = trim(substr($lines[$i]['text'], 1));
            if ($rest === '') {
                $i++;
                if ($i < $count && $lines[$i]['indent'] > $indent) {
                    $seq[] = self::parseBlock($lines, $i, $lines[$i]['indent']);
                } else {
                    $seq[] = null;
                }
                continue;
            }
            if (self::findKeyColon($rest) !== false) {
                // "- key: value" — a mapping whose first line rides on the dash
                $childIndent = $indent + 2;
                $lines[$i] = ['indent' => $childIndent, 'text' => $rest];
                $seq[] = self::parseMapping($lines, $i, $childIndent);
                continue;
            }
            $seq[] = self::parseScalar($rest);
            $i++;
        }
        return $seq;
    }

    /**
     * Drop a trailing `# comment` from a line.
     *
     * Only a `#` that follows whitespace starts a comment, which is what YAML says and
     * what keeps this safe for the ids already in the archive: `2023-01-budafest#3` has no
     * space before the hash, so it stays a value. A `#` inside quotes is never a comment.
     *
     * Frontmatter rarely carries comments, so the parser managed without this for a long
     * time. content/ranking.yml is hand-edited config where the comments are most of the
     * value of the file, and without this `authority: 0.80  # the WSDC score` silently
     * parses as the string "0.80  # the WSDC score".
     */
    public static function stripComment(string $text): string
    {
        $len = strlen($text);
        $quote = '';
        for ($p = 0; $p < $len; $p++) {
            $ch = $text[$p];
            if ($quote !== '') {
                if ($ch === '\\') { $p++; continue; }
                if ($ch === $quote) { $quote = ''; }
                continue;
            }
            if ($ch === '"' || $ch === "'") { $quote = $ch; continue; }
            if ($ch === '#' && ($p === 0 || $text[$p - 1] === ' ')) {
                return rtrim(substr($text, 0, $p));
            }
        }
        return $text;
    }

    /** Position of the ":" that separates a key from its value, ignoring quoted colons. */
    private static function findKeyColon(string $text)
    {
        $len = strlen($text);
        $quote = '';
        for ($p = 0; $p < $len; $p++) {
            $ch = $text[$p];
            if ($quote !== '') {
                if ($ch === '\\') { $p++; continue; }
                if ($ch === $quote) { $quote = ''; }
                continue;
            }
            if ($ch === '"' || $ch === "'") { $quote = $ch; continue; }
            if ($ch === ':' && ($p + 1 >= $len || $text[$p + 1] === ' ')) {
                return $p;
            }
        }
        return false;
    }

    private static function parseScalar(string $value)
    {
        $value = trim($value);
        if ($value === '' || $value === '~' || strcasecmp($value, 'null') === 0) {
            return null;
        }
        if (strcasecmp($value, 'true') === 0)  { return true; }
        if (strcasecmp($value, 'false') === 0) { return false; }
        if ($value[0] === '[') {
            return self::parseInlineSequence($value);
        }
        if ($value[0] === '"' || $value[0] === "'") {
            return self::unquote($value);
        }
        if (preg_match('/^-?\d+$/', $value)) {
            return (int) $value;
        }
        if (preg_match('/^-?\d*\.\d+$/', $value)) {
            return (float) $value;
        }
        return $value;
    }

    private static function parseInlineSequence(string $value): array
    {
        $inner = trim(substr($value, 1, max(0, strlen($value) - 2)));
        if ($inner === '') {
            return [];
        }
        $items = [];
        $buffer = '';
        $quote = '';
        $len = strlen($inner);
        for ($p = 0; $p < $len; $p++) {
            $ch = $inner[$p];
            if ($quote !== '') {
                $buffer .= $ch;
                if ($ch === '\\' && $p + 1 < $len) { $buffer .= $inner[++$p]; continue; }
                if ($ch === $quote) { $quote = ''; }
                continue;
            }
            if ($ch === '"' || $ch === "'") { $quote = $ch; $buffer .= $ch; continue; }
            if ($ch === ',') { $items[] = $buffer; $buffer = ''; continue; }
            $buffer .= $ch;
        }
        $items[] = $buffer;
        $out = [];
        foreach ($items as $item) {
            $item = trim($item);
            if ($item !== '') {
                $out[] = self::parseScalar($item);
            }
        }
        return $out;
    }

    private static function unquote(string $value): string
    {
        $quote = $value[0];
        $inner = substr($value, 1, strlen($value) - 2);
        if ($quote === '"') {
            return str_replace(['\\"', '\\\\', '\\n'], ['"', '\\', "\n"], $inner);
        }
        return str_replace("''", "'", $inner);
    }

    // ------------------------------------------------------------------ writing

    /** Render frontmatter in the canonical form the seeder also emits. */
    public static function dump(array $data, int $indent = 0): string
    {
        $pad = str_repeat(' ', $indent);
        $out = '';
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                if ($value === []) {
                    $out .= "$pad$key: []\n";
                } elseif (self::isScalarList($value)) {
                    $out .= "$pad$key: " . self::dumpInlineList($value) . "\n";
                } elseif (self::isList($value)) {
                    $out .= "$pad$key:\n";
                    foreach ($value as $item) {
                        if (is_array($item)) {
                            $rendered = self::dump($item, $indent + 4);
                            $out .= $pad . '  - ' . ltrim(substr($rendered, $indent + 4));
                        } else {
                            $out .= $pad . '  - ' . self::dumpScalar($item) . "\n";
                        }
                    }
                } else {
                    $out .= "$pad$key:\n" . self::dump($value, $indent + 2);
                }
                continue;
            }
            $out .= "$pad$key: " . self::dumpScalar($value) . "\n";
        }
        return $out;
    }

    public static function dumpScalar($value): string
    {
        if ($value === null)    { return 'null'; }
        if (is_bool($value))    { return $value ? 'true' : 'false'; }
        if (is_int($value) || is_float($value)) { return (string) $value; }
        return '"' . str_replace(['\\', '"', "\n"], ['\\\\', '\\"', ' '], (string) $value) . '"';
    }

    private static function dumpInlineList(array $values): string
    {
        $parts = [];
        foreach ($values as $value) {
            $parts[] = self::dumpScalar($value);
        }
        return '[' . implode(', ', $parts) . ']';
    }

    private static function isList(array $value): bool
    {
        return array_keys($value) === range(0, count($value) - 1);
    }

    private static function isScalarList(array $value): bool
    {
        if (!self::isList($value)) {
            return false;
        }
        foreach ($value as $item) {
            if (is_array($item)) {
                return false;
            }
        }
        return true;
    }

    /** Assemble a complete document. */
    public static function document(array $front, string $body): string
    {
        return "---\n" . self::dump($front) . "---\n\n" . ltrim($body, "\n");
    }
}
