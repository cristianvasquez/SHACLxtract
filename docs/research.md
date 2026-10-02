# Algorithm research

Source review behind the [readme](../readme.md) and the [Haskell manifest](../spec/manifest.hs). The readme defines the objective and API; this file records where the rules come from and which source behavior not to copy.

Reviewed snapshots: sheXer [`bfa82ae`](https://github.com/weso/shexer/tree/bfa82aebe8479eb42f5dfba054f221c72e7c21d3); SHACL Play [`996de4e`](https://github.com/sparna-git/shacl-play/tree/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a). Findings apply to these commits; neither library was executed. Local checkouts in `research/` are git-ignored.

## Ideas to retain

| Source | Algorithm | Decision |
| --- | --- | --- |
| sheXer | Build instance features, then aggregate class/property/value-type/cardinality frequencies. | Retain the separation between observations and shape selection. Count total property values separately from type-specific features. |
| sheXer | Rank constraints by observed frequency and generalize cardinalities. | Retain evidence counts. Defer threshold-based rejection of outliers until joint shape support is measured. |
| SHACL Play | Separate visitors infer node kinds, datatypes, classes, and cardinalities. | Retain independent inference functions; replace repeated SPARQL queries with shared indexes for local data. |
| SHACL Play | Detect missing properties and multiple values to propose minimum 1 and maximum 1. | Use these bounds as the first policy; keep exact observed extrema optional. |
| SHACL Play | Cache sampled instances when endpoint queries fail. | Endpoint support is required. Specify query completeness and make sampling explicit. |

## Source findings

- sheXer's [profiler](https://github.com/weso/shexer/blob/bfa82aebe8479eb42f5dfba054f221c72e7c21d3/shexer/core/profiling/class_profiler.py) separates instance annotation from class aggregation. Its [feature strategy](https://github.com/weso/shexer/blob/bfa82aebe8479eb42f5dfba054f221c72e7c21d3/shexer/core/profiling/strategy/abstract_feature_direction_strategy.py) records exact cardinality and positive closure. These are useful observations, but overlapping type categories cannot be summed to obtain property cardinality.
- Its [selection strategy](https://github.com/weso/shexer/blob/bfa82aebe8479eb42f5dfba054f221c72e7c21d3/shexer/core/shexing/strategy/abstract_shexing_strategy.py) divides feature occurrences by class population, groups candidates, and weakens cardinalities in all-compliant mode. A per-constraint ratio does not establish whole-shape conformance.
- Its [SHACL serializer](https://github.com/weso/shexer/blob/bfa82aebe8479eb42f5dfba054f221c72e7c21d3/shexer/io/shacl/formater/shacl_serializer.py) defines and emits `sh:dataType` instead of `sh:datatype`. Its macro table maps the wildcard to BlankNode and BNode to no constraint. These are concrete source defects; do not copy this serializer. An incorrect `rdfs:langString` constant also exists, but the inspected use is commented out.
- SHACL Play's [cardinality visitor](https://github.com/sparna-git/shacl-play/blob/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/visitors/AssignMinCountAndMaxCountVisitor.java) uses absence tests for minimum 1 and a multiple-value test for maximum 1. The [data provider](https://github.com/sparna-git/shacl-play/blob/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/providers/BaseShaclGeneratorDataProvider.java#L154) uses the [group-by query](https://github.com/sparna-git/shacl-play/blob/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a/shacl-generate/src/main/resources/shacl/generate/has-instance-with-two-properties-group-by.rq) (`HAVING count(?x) > 1`). The `sameTerm` and `!=` variants are commented out. Over a set-semantics graph the count equals the distinct-value count; over a default graph that merges named graphs, repeated triples can over-count.
- Its [class visitor](https://github.com/sparna-git/shacl-play/blob/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/visitors/AssignClassesVisitor.java) reduces classes using observed co-occurrence and emits class alternatives. The [object-type query](https://github.com/sparna-git/shacl-play/blob/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a/shacl-generate/src/main/resources/shacl/generate/select-object-types.rq) only returns typed objects. Thus this method alone cannot establish that every value satisfies a class constraint when untyped values are also present. Prefer the intersection of classes across all resource values for v1.
- Its [enumeration visitor](https://github.com/sparna-git/shacl-play/blob/996de4ea5c9a1c05f0fa68e59c27b2cdc669161a/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/visitors/AssignValueOrInVisitor.java) emits `sh:hasValue` for a singleton observed value set. Singleton range does not prove mandatory presence: a subject missing that property would fail. Defer enumeration inference.

## Proposed algorithm

For each class C and property p, let V(s,p) be the set of distinct RDF values for subject s. Record H(k), the number of target subjects for which |V(s,p)| = k. Include missing properties: H(0) is population minus the number of subjects with p.

Example: three subjects have 2, 1, and 0 values. H = {0:1, 1:1, 2:1}; property presence is 2/3. The default policy proposes neither minimum 1 nor maximum 1. The optional extrema policy proposes maximum 2. Neither policy proves a domain rule for future data.

Build value alternatives per value, not per subject. If a property has both strings and integers, use a property shape whose value constraint is an OR of those datatypes. Preserve a resource branch for untyped resources. Use common classes only when every resource value has them, reduced to the most specific classes. Several `sh:class` values on one shape are a valid conjunction. Do not infer recursive `sh:node` links from class membership.

Require explicit graph selection. To keep graphs separate, run extraction once per graph; each run yields its own shape set and validation run. A union is an explicit projection that deduplicates repeated triples. Resolve subclass membership within that same graph so target populations match `sh:targetClass` semantics. These choices follow the [SHACL Recommendation](https://www.w3.org/TR/shacl/), particularly class targets, cardinality, datatype and logical constraints.

Keep the core independent of parsers, serializers, SPARQL engines, and validators. Accept RDF/JS quads and a caller-supplied factory; return shape quads. Evidence stays in the internal proposal in v1. The existing validator can check proposals through an adapter. Its exact package/API has not been established here.

## Implementation acceptance cases

Check duplicate quads; shuffled input with late type declarations; missing properties; multiple values and multiple types; mixed literal/resource values; untyped objects; subclass cycles; identical triples in different graphs; empty target classes; language-tagged literals; invalid datatype lexical forms; one observed type per instance (no `rdf:type` bounds); several common classes and a superclass (most specific only, several `sh:class` values); IRI and blank-node values (`sh:BlankNodeOrIRI`); shape IRI collisions; and an endpoint result truncated below its row count (error). These cases are tests in [`test/`](../test/). Verify emitted shapes with the existing validator, including negative examples that must fail. A positive training-data check alone cannot detect silently ignored predicates such as `sh:dataType`.

No runtime or memory measurements have been made. The proposed local algorithm retains indexes; it is not a constant-memory streaming algorithm. Sampling, structural clustering of untyped subjects, inverse paths, recursive shapes, enumerations, and statistical outlier policies remain later extensions.
