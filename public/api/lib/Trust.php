<?php
/**
 * The trust ladder.
 *
 * Nothing imported from elsewhere is treated as fact — not the upstream concept graph,
 * not the classifier's tags, not YouTube's metadata, not the WSDC identity match. Every
 * edge and every contested field carries where it came from and how sure we are, and the
 * only ways up the ladder are corroborating evidence or a human saying so.
 *
 *   imported      came from somewhere else, unreviewed           shown as "suggested"
 *   corroborated  the video corpus independently supports it     shown as "usually first"
 *   verified      a human confirmed it, with a name and a date   shown as "required first"
 *   disputed      evidence contradicts it                        hidden from paths
 *
 * The rule that matters most is in merge(): a re-import can never demote something a
 * human verified. That is what makes "import is a diff, never an overwrite" true in code
 * rather than only in the plan.
 */
class Trust
{
    const IMPORTED     = 'imported';
    const CORROBORATED = 'corroborated';
    const VERIFIED     = 'verified';
    const DISPUTED     = 'disputed';

    /** Confidence an edge starts at when it arrives unreviewed: genuinely uncertain. */
    const IMPORTED_CONFIDENCE = 0.5;

    /**
     * Height on the ladder. `disputed` is deliberately not on it — it is not "less
     * trusted", it is a live contradiction, and it sorts below everything.
     */
    private static $rank = [
        self::DISPUTED     => -1,
        self::IMPORTED     => 0,
        self::CORROBORATED => 1,
        self::VERIFIED     => 2,
    ];

    /**
     * How a prerequisite is worded to a learner.
     *
     * The upstream graph conflates "you cannot do this without that" with "teachers
     * usually cover that first". Saying *Required* when we mean *commonly sequenced*
     * sends people away to learn something they did not need, so the two stay separate
     * all the way to the page.
     */
    private static $strengthLabels = [
        'required'               => 'Required first',
        'usually-taught-before'  => 'Usually taught before this',
        'related'                => 'Related',
    ];

    public static function rank(string $trust): int
    {
        return isset(self::$rank[$trust]) ? self::$rank[$trust] : 0;
    }

    public static function isKnown(string $trust): bool
    {
        return isset(self::$rank[$trust]);
    }

    /**
     * Canonical form of one edge.
     *
     * Accepts a bare string ("anchor-step"), which is how the upstream graph writes them,
     * and turns it into a structured edge that admits it is unreviewed. That asymmetry is
     * the point: a bare id cannot claim to be verified.
     */
    public static function edge($raw, string $origin = 'unknown'): ?array
    {
        if (is_string($raw)) {
            $raw = ['id' => $raw];
        }
        if (!is_array($raw) || !isset($raw['id']) || !is_string($raw['id']) || $raw['id'] === '') {
            return null;
        }
        $trust = isset($raw['trust']) && is_string($raw['trust']) && self::isKnown($raw['trust'])
            ? $raw['trust']
            : self::IMPORTED;

        $edge = [
            'id'         => $raw['id'],
            'origin'     => isset($raw['origin']) && $raw['origin'] !== '' ? (string) $raw['origin'] : $origin,
            'trust'      => $trust,
            'confidence' => self::clamp(
                isset($raw['confidence']) ? $raw['confidence'] : self::defaultConfidence($trust)
            ),
            'strength'   => isset($raw['strength']) && isset(self::$strengthLabels[$raw['strength']])
                ? $raw['strength']
                : 'required',
        ];
        foreach (['evidence', 'weight', 't', 'note'] as $optional) {
            if (isset($raw[$optional])) {
                $edge[$optional] = $raw[$optional];
            }
        }
        return $edge;
    }

    /** @return array<int,array> every edge in a field, canonicalised, nulls dropped. */
    public static function edges($raw, string $origin = 'unknown'): array
    {
        if (!is_array($raw)) {
            return [];
        }
        $out = [];
        foreach ($raw as $item) {
            $edge = self::edge($item, $origin);
            if ($edge !== null) {
                $out[] = $edge;
            }
        }
        return $out;
    }

    private static function defaultConfidence(string $trust): float
    {
        switch ($trust) {
            case self::VERIFIED:     return 1.0;
            case self::CORROBORATED: return 0.75;
            case self::DISPUTED:     return 0.1;
            default:                 return self::IMPORTED_CONFIDENCE;
        }
    }

    public static function clamp($value): float
    {
        $value = is_numeric($value) ? (float) $value : self::IMPORTED_CONFIDENCE;
        return max(0.0, min(1.0, $value));
    }

    /**
     * Merge an incoming edge over a local one — the whole of "import is a diff".
     *
     * A re-import arrives as `imported`. If the local copy has been verified or
     * corroborated since, the incoming one must not undo that: it is the *older* opinion,
     * however recently it was fetched. Losing a human's review to a routine sync is the
     * failure this exists to prevent.
     *
     * When the two disagree on something substantive while the local side outranks the
     * incoming side, the disagreement is recorded on the edge rather than resolved. It is
     * then visible in the audit and can be pushed back upstream, instead of being
     * silently decided by whichever sync ran last.
     *
     * @return array [array $edge, bool $changed]
     */
    public static function merge(?array $local, array $incoming): array
    {
        if ($local === null) {
            return [$incoming, true];
        }
        if (self::rank($incoming['trust']) > self::rank($local['trust'])) {
            return [$incoming, true];                       // genuinely better evidence
        }
        if (self::rank($incoming['trust']) === self::rank($local['trust'])
            && $local['trust'] === self::IMPORTED) {
            $changed = self::differs($local, $incoming);
            return [$incoming, $changed];                   // both unreviewed: upstream wins
        }

        // Local outranks incoming. Keep it, but remember that upstream says otherwise.
        //
        // Only `strength` counts as a disagreement here. Confidence is a function of trust
        // — a verified edge is 1.0, an imported one 0.5 — so comparing it would mark every
        // verified-versus-imported pair as conflicting and turn the marker into noise. The
        // substantive disagreement is about what the learner is told.
        $conflict = $local['strength'] !== $incoming['strength'];
        if (!$conflict) {
            unset($local['upstream']);
            return [$local, false];
        }
        $local['upstream'] = [
            'strength'   => $incoming['strength'],
            'confidence' => $incoming['confidence'],
            'origin'     => $incoming['origin'],
        ];
        return [$local, true];
    }

    /** Do two edges disagree about anything a reader would notice? */
    public static function differs(array $a, array $b): bool
    {
        if ($a['strength'] !== $b['strength']) {
            return true;
        }
        return abs($a['confidence'] - $b['confidence']) > 0.01;
    }

    /**
     * Is this edge allowed to shape a learning path?
     *
     * A disputed edge is not: evidence says it is wrong, and routing someone through a
     * prerequisite we believe is wrong is worse than omitting it.
     */
    public static function usable(array $edge): bool
    {
        return $edge['trust'] !== self::DISPUTED;
    }

    /** What a learner is told about this edge. Never states more than we know. */
    public static function label(array $edge): string
    {
        if ($edge['trust'] === self::IMPORTED) {
            return 'Suggested — not reviewed';
        }
        if ($edge['trust'] === self::DISPUTED) {
            return 'Disputed';
        }
        $strength = isset(self::$strengthLabels[$edge['strength']])
            ? self::$strengthLabels[$edge['strength']]
            : 'Related';
        if ($edge['trust'] === self::CORROBORATED && $edge['strength'] === 'required') {
            return 'Usually taught before this';   // corroboration is not confirmation
        }
        return $strength;
    }

    /**
     * Summarise the trust across a set of edges, for a badge on a listing.
     * @return array{verified:int,corroborated:int,imported:int,disputed:int}
     */
    public static function summary(array $edges): array
    {
        $out = [self::VERIFIED => 0, self::CORROBORATED => 0, self::IMPORTED => 0, self::DISPUTED => 0];
        foreach ($edges as $edge) {
            if (isset($out[$edge['trust']])) {
                $out[$edge['trust']]++;
            }
        }
        return $out;
    }
}
