<?php
/**
 * The concept graph: traversal, ordering, and the audit that keeps it honest.
 *
 * Nothing stores a backlink. "Which concepts need this one?" and "which videos teach it?"
 * are computed on every request, so they cannot rot — the rule teaching.westie.si follows,
 * and the reason its data has stayed referentially clean through three years of edits.
 *
 * Every traversal here is trust-aware. A path never routes a learner through a `disputed`
 * prerequisite, and an `imported` one is carried with its uncertainty intact rather than
 * being silently promoted to a rule by the act of being walked.
 */
class Graph
{
    private $store;
    private $concepts = null;
    /** @var array<string,array<int,array>> concept key => canonical requires edges */
    private $edges = null;
    /** @var array<string,array<int,string>> concept key => keys that require it */
    private $reverse = null;

    public function __construct(Store $store)
    {
        $this->store = $store;
    }

    // ------------------------------------------------------------------- loading

    private function load(): void
    {
        if ($this->concepts !== null) {
            return;
        }
        $this->concepts = $this->store->all('concepts');
        $this->edges = [];
        $this->reverse = [];
        foreach ($this->concepts as $key => $concept) {
            $origin = isset($concept['id']) ? 'concept:' . $concept['id'] : 'concept:' . $key;
            $edges = Trust::edges(isset($concept['requires']) ? $concept['requires'] : [], $origin);
            // Drop edges pointing at concepts that do not exist. They are reported by
            // audit(), and carrying them through a traversal only produces null holes.
            $edges = array_values(array_filter($edges, function ($edge) {
                return isset($this->concepts[$edge['id']]);
            }));
            $this->edges[$key] = $edges;
            foreach ($edges as $edge) {
                $this->reverse[$edge['id']][] = $key;
            }
        }
    }

    public function concepts(): array
    {
        $this->load();
        return $this->concepts;
    }

    public function has(string $key): bool
    {
        $this->load();
        return isset($this->concepts[$key]);
    }

    /** Canonical prerequisite edges of one concept, unfiltered. */
    public function requires(string $key): array
    {
        $this->load();
        return isset($this->edges[$key]) ? $this->edges[$key] : [];
    }

    /** Which concepts name this one as a prerequisite. Computed, never stored. */
    public function dependents(string $key): array
    {
        $this->load();
        return isset($this->reverse[$key]) ? array_values(array_unique($this->reverse[$key])) : [];
    }

    // ---------------------------------------------------------------- traversal

    /**
     * Everything a learner should already know before this concept, deepest first.
     *
     * `$minTrust` decides what counts as a prerequisite worth routing through. The default
     * walks everything except disputed edges, but each returned row carries its own trust
     * so the page can render a reviewed prerequisite differently from a guessed one.
     *
     * @return array<int,array{id:string,depth:int,via:array,trust:string}>
     */
    public function prerequisites(string $key, int $maxDepth = 6): array
    {
        $this->load();
        if (!isset($this->concepts[$key])) {
            return [];
        }
        $seen = [$key => true];
        $out = [];
        $frontier = [[$key, 0]];
        while ($frontier) {
            list($current, $depth) = array_shift($frontier);
            if ($depth >= $maxDepth) {
                continue;
            }
            foreach ($this->edges[$current] as $edge) {
                if (!Trust::usable($edge)) {
                    continue;                       // never route through a contradiction
                }
                if (isset($seen[$edge['id']])) {
                    continue;
                }
                $seen[$edge['id']] = true;
                $out[] = [
                    'id'         => $edge['id'],
                    'depth'      => $depth + 1,
                    'trust'      => $edge['trust'],
                    'strength'   => $edge['strength'],
                    'confidence' => $edge['confidence'],
                    'label'      => Trust::label($edge),
                    'via'        => $current,
                ];
                $frontier[] = [$edge['id'], $depth + 1];
            }
        }
        usort($out, function ($a, $b) {
            return $b['depth'] <=> $a['depth'];     // foundations first
        });
        return $out;
    }

    /** What this concept unlocks — one step out, ordered by level then title. */
    public function unlocks(string $key): array
    {
        $this->load();
        $out = [];
        foreach ($this->dependents($key) as $dependent) {
            $concept = $this->concepts[$dependent];
            $out[] = [
                'id'    => $dependent,
                'title' => isset($concept['title']) ? $concept['title'] : $dependent,
                'level' => isset($concept['level']) ? (int) $concept['level'] : 0,
            ];
        }
        usort($out, function ($a, $b) {
            return [$a['level'], $a['title']] <=> [$b['level'], $b['title']];
        });
        return $out;
    }

    /**
     * A teachable order for a set of concepts: prerequisites before the things that need
     * them, and within a tier, easier before harder.
     *
     * Kahn's algorithm over the induced subgraph. If a cycle survives audit() and reaches
     * here, the remaining nodes are appended in level order rather than dropped — a
     * learning path that is slightly mis-ordered beats one with a hole in it.
     */
    public function topoOrder(array $keys): array
    {
        $this->load();
        $set = [];
        foreach ($keys as $key) {
            if (isset($this->concepts[$key])) {
                $set[$key] = true;
            }
        }
        $indegree = array_fill_keys(array_keys($set), 0);
        $forward = [];
        foreach ($set as $key => $_) {
            foreach ($this->edges[$key] as $edge) {
                if (!isset($set[$edge['id']]) || !Trust::usable($edge)) {
                    continue;
                }
                $forward[$edge['id']][] = $key;
                $indegree[$key]++;
            }
        }
        $ready = [];
        foreach ($indegree as $key => $degree) {
            if ($degree === 0) {
                $ready[] = $key;
            }
        }
        $sortByLevel = function (array &$list) {
            usort($list, function ($a, $b) {
                $ca = $this->concepts[$a];
                $cb = $this->concepts[$b];
                return [(int) ($ca['level'] ?? 0), $ca['title'] ?? $a]
                   <=> [(int) ($cb['level'] ?? 0), $cb['title'] ?? $b];
            });
        };
        $sortByLevel($ready);

        $out = [];
        while ($ready) {
            $key = array_shift($ready);
            $out[] = $key;
            $added = false;
            foreach ($forward[$key] ?? [] as $next) {
                if (--$indegree[$next] === 0) {
                    $ready[] = $next;
                    $added = true;
                }
            }
            if ($added) {
                $sortByLevel($ready);
            }
        }
        if (count($out) < count($set)) {            // cycle: append the rest in level order
            $stuck = array_values(array_diff(array_keys($set), $out));
            $sortByLevel($stuck);
            $out = array_merge($out, $stuck);
        }
        return $out;
    }

    // -------------------------------------------------------------------- audit

    /**
     * Everything structurally suspect about the graph, as data.
     *
     * Written to content/.audit/graph.json on every build and turned into review-queue
     * entries. Findings that are only printed get ignored; findings that arrive as a work
     * queue get fixed.
     *
     * Only `cycles` and `dangling` are build-breaking, because they are the two that make
     * the path algorithms wrong rather than merely unreviewed. Everything else is a
     * judgment call for a human.
     */
    public function audit(): array
    {
        $this->load();
        $total = count($this->concepts);

        $dangling = [];
        $edgeCount = 0;
        $trustCount = [Trust::VERIFIED => 0, Trust::CORROBORATED => 0, Trust::IMPORTED => 0, Trust::DISPUTED => 0];
        foreach ($this->concepts as $key => $concept) {
            foreach (Trust::edges($concept['requires'] ?? [], 'concept:' . $key) as $edge) {
                $edgeCount++;
                if (isset($trustCount[$edge['trust']])) {
                    $trustCount[$edge['trust']]++;
                }
                if (!isset($this->concepts[$edge['id']])) {
                    $dangling[] = ['concept' => $key, 'requires' => $edge['id']];
                }
            }
        }

        return [
            'generated'  => date('c'),
            'concepts'   => $total,
            'edges'      => $edgeCount,
            'density'    => $total > 0 ? round($edgeCount / $total, 2) : 0.0,
            'trust'      => $trustCount,
            'unreviewed' => $this->unreviewedShare(),
            'cycles'     => $this->cycles(),
            'dangling'   => $dangling,
            'inversions' => $this->levelInversions(),
            'orphans'    => $this->orphans(),
            'uncovered'  => $this->uncovered(),
            'sparse'     => $this->sparse(),
        ];
    }

    /** Depth-first cycle detection. Returns each cycle as the ring of keys involved. */
    public function cycles(): array
    {
        $this->load();
        $state = [];              // 0 unvisited, 1 on the stack, 2 done
        $cycles = [];
        $stack = [];
        $visit = function ($key) use (&$visit, &$state, &$cycles, &$stack) {
            $state[$key] = 1;
            $stack[] = $key;
            foreach ($this->edges[$key] as $edge) {
                $next = $edge['id'];
                if (($state[$next] ?? 0) === 1) {
                    $at = array_search($next, $stack, true);
                    if ($at !== false) {
                        $cycles[] = array_merge(array_slice($stack, $at), [$next]);
                    }
                } elseif (($state[$next] ?? 0) === 0) {
                    $visit($next);
                }
            }
            array_pop($stack);
            $state[$key] = 2;
        };
        foreach (array_keys($this->concepts) as $key) {
            if (($state[$key] ?? 0) === 0) {
                $visit($key);
            }
        }
        return $cycles;
    }

    /**
     * A concept whose prerequisite is filed at a *higher* level than itself.
     *
     * Three of the four found in the upstream import were the same bug: a compound move
     * filed below its own component (`acceleration-into-whip` at L3 requiring
     * `acceleration` at L4). Structurally legal, obviously wrong, and invisible until
     * something looks for it.
     */
    public function levelInversions(): array
    {
        $this->load();
        $out = [];
        foreach ($this->concepts as $key => $concept) {
            $level = (int) ($concept['level'] ?? 0);
            if ($level <= 0) {
                continue;
            }
            foreach ($this->edges[$key] as $edge) {
                $required = (int) ($this->concepts[$edge['id']]['level'] ?? 0);
                if ($required > $level) {
                    $out[] = [
                        'concept'        => $key,
                        'level'          => $level,
                        'requires'       => $edge['id'],
                        'requires_level' => $required,
                        'trust'          => $edge['trust'],
                    ];
                }
            }
        }
        return $out;
    }

    /** Concepts with no edge in either direction — unplaced in the graph. */
    public function orphans(): array
    {
        $this->load();
        $out = [];
        foreach ($this->concepts as $key => $_) {
            if (empty($this->edges[$key]) && empty($this->reverse[$key])) {
                $out[] = $key;
            }
        }
        return $out;
    }

    /** Concepts with no video attached. This is the ingestion shopping list. */
    public function uncovered(): array
    {
        $this->load();
        $out = [];
        foreach ($this->concepts as $key => $concept) {
            if (empty($concept['videos'])) {
                $out[] = $key;
            }
        }
        return $out;
    }

    /**
     * Concepts above level 1 that declare no prerequisites at all.
     *
     * Sparsity is the subtler failure than error: the upstream graph averages 1.2
     * prerequisites per concept, so most concepts under-declare what they rest on, and a
     * path built naively on it looks complete while quietly skipping things. A level-3
     * concept that needs nothing is almost always missing its edges rather than genuinely
     * foundational.
     */
    public function sparse(): array
    {
        $this->load();
        $out = [];
        foreach ($this->concepts as $key => $concept) {
            $level = (int) ($concept['level'] ?? 0);
            if ($level > 1 && empty($this->edges[$key])) {
                $out[] = ['concept' => $key, 'level' => $level];
            }
        }
        return $out;
    }

    /** Share of concepts that no human has reviewed. */
    private function unreviewedShare(): array
    {
        $draft = 0;
        $generated = 0;
        foreach ($this->concepts as $concept) {
            if (($concept['status'] ?? 'draft') === 'draft') {
                $draft++;
            }
            if (!empty($concept['generated'])) {
                $generated++;
            }
        }
        return ['draft' => $draft, 'generated' => $generated, 'of' => count($this->concepts)];
    }
}
