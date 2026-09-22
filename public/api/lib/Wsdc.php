<?php
/**
 * Authority from WSDC standing.
 *
 * The editorial rule — prefer teachers who compete at the top of the event scene — stated
 * as a computation over public competition data rather than as a list of names somebody
 * has to keep current. A dancer who breaks into Champions this season moves up at the next
 * sync without anyone editing a config file.
 *
 * It also expresses the negative case correctly. Someone who does not compete on the
 * circuit has no WSDC record, so they score `unregistered` — not because a human decided
 * to rank them low, but because the objective signal is absent, which is precisely what
 * "not on the event scene" means.
 *
 * The one thing this must never do is conflate "no record" with "nobody has checked yet".
 * See status() below; it is the reason the class exists in this shape.
 */
class Wsdc
{
    /** Highest first. A dancer's division is the best one they hold points in. */
    const DIVISIONS = ['CHA', 'ALS', 'ADV', 'INT', 'NOV', 'NEW'];

    const UNCONFIRMED = 'unconfirmed';   // no id confirmed yet — we have not looked
    const CONFIRMED   = 'confirmed';     // id confirmed by a human, points mirrored
    const NONE        = 'none';          // looked up and genuinely not in the registry
    const AMBIGUOUS   = 'ambiguous';     // several plausible dancers share the name

    private $config;

    public function __construct(array $rankingConfig)
    {
        $this->config = isset($rankingConfig['authority']) ? $rankingConfig['authority'] : [];
    }

    /**
     * Points in each division, taken as the better of the two roles.
     *
     * Leading and following are separate records with separate points. A teacher's standing
     * is the stronger of the two — someone who competes Champions as a follower and Novice
     * as a leader is a Champions-level teacher.
     */
    public static function bestByDivision(array $wsdc): array
    {
        $out = array_fill_keys(self::DIVISIONS, 0);
        foreach (['leader', 'follower'] as $role) {
            if (!isset($wsdc[$role]) || !is_array($wsdc[$role])) {
                continue;
            }
            foreach (self::DIVISIONS as $division) {
                $points = isset($wsdc[$role][$division]) ? (int) $wsdc[$role][$division] : 0;
                if ($points > $out[$division]) {
                    $out[$division] = $points;
                }
            }
        }
        return $out;
    }

    /** The highest division the dancer holds any points in, or null. */
    public static function topDivision(array $byDivision): ?string
    {
        foreach (self::DIVISIONS as $division) {
            if (($byDivision[$division] ?? 0) > 0) {
                return $division;
            }
        }
        return null;
    }

    /** What we actually know about this creator's identity in the registry. */
    public static function status(array $creator): string
    {
        $status = $creator['wsdc_status'] ?? null;
        $known = [self::UNCONFIRMED, self::CONFIRMED, self::NONE, self::AMBIGUOUS];
        if (is_string($status) && in_array($status, $known, true)) {
            return $status;
        }
        // No explicit status: an id alone is not a confirmation, so assume the weaker claim.
        return self::UNCONFIRMED;
    }

    /**
     * Authority 0–100 for one creator.
     *
     * @return array{score:float,basis:string,division:?string,points:int,provisional:bool}
     */
    public function score(array $creator): array
    {
        if (isset($creator['authority_override']) && is_numeric($creator['authority_override'])) {
            return [
                'score'       => (float) max(0, min(100, $creator['authority_override'])),
                'basis'       => 'set by hand',
                'division'    => null,
                'points'      => 0,
                'provisional' => false,
            ];
        }

        $status = self::status($creator);
        if ($status === self::UNCONFIRMED || $status === self::AMBIGUOUS) {
            return [
                'score'       => (float) ($this->config['unconfirmed'] ?? 45),
                'basis'       => $status === self::AMBIGUOUS
                    ? 'WSDC identity ambiguous — needs a human'
                    : 'WSDC id not confirmed yet',
                'division'    => null,
                'points'      => 0,
                'provisional' => true,
            ];
        }
        if ($status === self::NONE) {
            return [
                'score'       => (float) ($this->config['unregistered'] ?? 8),
                'basis'       => 'no WSDC record',
                'division'    => null,
                'points'      => 0,
                'provisional' => false,
            ];
        }

        $byDivision = self::bestByDivision($creator['wsdc'] ?? []);
        $division = self::topDivision($byDivision);
        if ($division === null) {
            return [
                'score'       => (float) ($this->config['registered_no_points'] ?? 12),
                'basis'       => 'WSDC record with no points',
                'division'    => null,
                'points'      => 0,
                'provisional' => false,
            ];
        }

        $points = $byDivision[$division];
        $band = $this->config['divisions'][$division] ?? null;
        if (!is_array($band)) {
            return [
                'score'       => (float) ($this->config['registered_no_points'] ?? 12),
                'basis'       => "unknown division $division",
                'division'    => $division,
                'points'      => $points,
                'provisional' => false,
            ];
        }
        $base = (float) ($band['base'] ?? 0);
        $span = (float) ($band['span'] ?? 0);
        $per = max(1.0, (float) ($band['per_point'] ?? 100));
        $score = $base + min($span, $points / $per);

        return [
            'score'       => round(max(0.0, min(100.0, $score)), 1),
            'basis'       => sprintf('%s division, %d pts', $division, $points),
            'division'    => $division,
            'points'      => $points,
            'provisional' => false,
        ];
    }

    /**
     * Authority for a video, from whoever teaches it.
     *
     * The max, not the mean: a champion teaching alongside a less-titled partner is still
     * a champion teaching. Averaging would penalise exactly the pairings most worth
     * watching.
     *
     * A video with no creators resolved is provisional rather than unregistered — the same
     * distinction as above, for the same reason.
     */
    public function forVideo(array $creators): array
    {
        if (!$creators) {
            return [
                'score'       => (float) ($this->config['unconfirmed'] ?? 45),
                'basis'       => 'no creator resolved yet',
                'provisional' => true,
                'from'        => null,
            ];
        }
        $best = null;
        foreach ($creators as $key => $creator) {
            $scored = $this->score($creator);
            if ($best === null || $scored['score'] > $best['score']) {
                $best = $scored;
                $best['from'] = is_string($key) ? $key : ($creator['id'] ?? null);
            }
        }
        return $best;
    }
}
