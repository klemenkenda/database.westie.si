<?php
/**
 * Result ordering.
 *
 * A blend of five signals whose weights live in content/ranking.yml, because a ranking you
 * cannot retune without a deploy is a ranking you stop retuning.
 *
 * Two things here are not negotiable by weight:
 *
 *   - **Demotion is a tier, not a penalty.** A demoted creator sorts after everything
 *     non-demoted whatever its score. Points can always be out-argued by enough of another
 *     signal; a tier cannot. That is what "at the back of the list, but still there" needs.
 *   - **Every score explains itself.** A ranking you disagree with and cannot inspect is
 *     one you have to take on faith, so each result carries the terms that produced it.
 */
class Rank
{
    private $weights;
    private $tiers;
    private $penalties;
    private $wsdc;

    public function __construct(array $config, Wsdc $wsdc)
    {
        $this->weights = ($config['weights'] ?? []) + [
            'relevance' => 1.0, 'authority' => 0.8, 'votes' => 0.5, 'fit' => 0.4, 'freshness' => 0.1,
        ];
        $this->tiers = ($config['tiers'] ?? []) + ['demoted_always_last' => true, 'hide_below_authority' => 0];
        $this->penalties = ($config['penalties'] ?? []) + ['no_transcript' => 0.0, 'unreviewed_classification' => 0.0];
        $this->wsdc = $wsdc;
    }

    /**
     * Wilson lower bound of the positive rate at 95% confidence.
     *
     * Three upvotes and nothing else is weak evidence; two hundred upvotes against ten is
     * strong. The raw ratio cannot tell them apart — both are "high" — so a new video with
     * a handful of friendly votes would outrank a proven one. The lower bound of the
     * interval grows with the count, which is the property we actually want.
     */
    public static function wilson(int $up, int $down): float
    {
        $n = $up + $down;
        if ($n === 0) {
            return 0.0;
        }
        $z = 1.96;
        $phat = $up / $n;
        $denominator = 1 + ($z * $z) / $n;
        $centre = $phat + ($z * $z) / (2 * $n);
        $margin = $z * sqrt(($phat * (1 - $phat) + ($z * $z) / (4 * $n)) / $n);
        return max(0.0, min(1.0, ($centre - $margin) / $denominator));
    }

    /** Mild decay, roughly a five-year half-life. Recency is a tiebreaker, not a verdict. */
    public static function freshness(?string $published, ?int $now = null): float
    {
        if (!$published) {
            return 0.5;
        }
        $timestamp = strtotime($published);
        if ($timestamp === false) {
            return 0.5;
        }
        $years = max(0.0, (($now ?? time()) - $timestamp) / (365.25 * 24 * 3600));
        return (float) pow(0.5, $years / 5.0);
    }

    /**
     * How well a video fits what was asked for.
     *
     * Concept-edge weight times its confidence, so a video that merely might cover the
     * concept contributes less than one that demonstrably does — the trust model reaching
     * all the way into the ordering.
     */
    public static function fit(array $video, ?string $concept, ?int $level): float
    {
        $score = 0.0;
        if ($concept !== null) {
            foreach ($video['concepts'] ?? [] as $edge) {
                if (is_array($edge) && ($edge['id'] ?? null) === $concept) {
                    $weight = isset($edge['weight']) ? (float) $edge['weight'] : 1.0;
                    $confidence = isset($edge['confidence']) ? (float) $edge['confidence'] : 0.5;
                    $score += max(0.0, min(1.0, $weight)) * max(0.0, min(1.0, $confidence));
                    break;
                }
            }
        }
        if ($level !== null) {
            $videoLevel = isset($video['level']) ? (int) $video['level'] : 0;
            if ($videoLevel === $level) {
                $score += 0.5;
            } elseif ($videoLevel > 0 && abs($videoLevel - $level) === 1) {
                $score += 0.2;
            }
            $range = $video['level_range'] ?? null;
            if (is_array($range) && count($range) === 2 && $level >= $range[0] && $level <= $range[1]) {
                $score += 0.2;
            }
        }
        return min(1.5, $score);
    }

    /**
     * Score one video.
     *
     * @param array $creators creator records keyed by id, for the video's creators only
     * @param array $votes    ['up' => int, 'down' => int]
     * @param array $context  ['relevance' => float, 'concept' => ?string, 'level' => ?int]
     */
    public function score(array $video, array $creators, array $votes = [], array $context = []): array
    {
        $authority = $this->wsdc->forVideo($creators);
        $relevance = (float) ($context['relevance'] ?? 0.0);
        $up = (int) ($votes['up'] ?? 0);
        $down = (int) ($votes['down'] ?? 0);
        $wilson = self::wilson($up, $down);
        $fit = self::fit($video, $context['concept'] ?? null, $context['level'] ?? null);
        $freshness = self::freshness($video['published'] ?? null, $context['now'] ?? null);

        $terms = [];
        $total = 0.0;

        $add = function (string $label, float $weight, float $value, string $why) use (&$terms, &$total) {
            $contribution = $weight * $value;
            if (abs($contribution) < 0.0005) {
                return;
            }
            $total += $contribution;
            $terms[] = ['label' => $label, 'contribution' => round($contribution, 3), 'why' => $why];
        };

        $add('relevance', (float) $this->weights['relevance'], $relevance, 'search match');
        $add('authority', (float) $this->weights['authority'], $authority['score'] / 100.0, $authority['basis']);
        if ($up + $down > 0) {
            $add('votes', (float) $this->weights['votes'], $wilson, sprintf('%d up, %d down', $up, $down));
        }
        $add('fit', (float) $this->weights['fit'], $fit, 'level and concept match');
        $add('freshness', (float) $this->weights['freshness'], $freshness, 'published ' . ($video['published'] ?? 'unknown'));

        if (empty($video['has_transcript'])) {
            $add('no transcript', 1.0, (float) $this->penalties['no_transcript'], 'nothing to search inside');
        }
        if ($this->isUnreviewed($video)) {
            $add('unreviewed tags', 1.0, (float) $this->penalties['unreviewed_classification'], 'classification not checked');
        }

        return [
            'score'       => round($total, 4),
            'tier'        => $this->tierOf($video, $creators),
            'authority'   => $authority,
            'provisional' => !empty($authority['provisional']),
            'terms'       => $terms,
        ];
    }

    /**
     * 0 for ordinary material, 1 for demoted.
     *
     * A brand rather than a dancer cannot be expressed in competition points, so it is
     * marked on the creator or channel record instead. Sorting by tier first is what makes
     * the mark absolute.
     */
    private function tierOf(array $video, array $creators): int
    {
        if (!empty($video['demoted'])) {
            return 1;
        }
        foreach ($creators as $creator) {
            if (!empty($creator['demote'])) {
                return 1;
            }
        }
        return 0;
    }

    private function isUnreviewed(array $video): bool
    {
        foreach ($video['concepts'] ?? [] as $edge) {
            if (is_array($edge) && ($edge['source'] ?? '') === 'llm' && ($edge['confidence'] ?? 1) < 0.75) {
                return true;
            }
        }
        return false;
    }

    /**
     * Order a scored set. Tier first, always; score within the tier.
     *
     * @param array $scored [key => result of score()]
     */
    public static function order(array $scored): array
    {
        uasort($scored, function ($a, $b) {
            if ($a['tier'] !== $b['tier']) {
                return $a['tier'] <=> $b['tier'];      // demoted sinks, whatever it scored
            }
            return $b['score'] <=> $a['score'];
        });
        return $scored;
    }

    /** One line a person can read, e.g. "CHA division, 2140 pts (+0.79) | 14 up, 2 down (+0.31)". */
    public static function explain(array $result): string
    {
        $parts = [];
        foreach ($result['terms'] as $term) {
            $parts[] = sprintf('%s (%+.2f)', $term['why'], $term['contribution']);
        }
        $line = implode(' | ', $parts);
        if ($result['tier'] === 1) {
            $line = 'demoted — sorts last | ' . $line;
        }
        if (!empty($result['provisional'])) {
            $line .= ' | authority provisional';
        }
        return $line;
    }
}
