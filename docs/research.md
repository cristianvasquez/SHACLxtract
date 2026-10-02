# Algorithm research

These notes record the source review and initial local algorithm. The [readme](../readme.md) defines the current objective, including SPARQL endpoint input.

The initial local proposal was a Node.js library that reads RDF instance data, groups subjects by class, counts their property values, and writes a SHACL shape for each class. Its internal profile retains counts that explain each proposed constraint. The public API returns the shapes dataset directly. You then check these shapes with your existing validator.

In the simplest use, supply one selected RDF graph. The same algorithm can run separately for each graph, or over an explicitly selected union. For each class:

1. Find its instances, including instances of declared subclasses.
2. For each property used by those instances, count distinct values per instance. Include zero when an instance lacks the property.
3. Propose `sh:minCount 1` if all instances have the property. Propose `sh:maxCount 1` if none has more than one value.
4. Describe the observed value kinds and datatypes. For resource values, propose only classes shared by all those values.
5. Write the shape and retain the observations that justify it.

This rule set describes the supplied data. You must review the generated constraints before using them as requirements for future data.

## Worked example

Suppose the selected graph contains three instances of `ex:Person`:

| Person | `ex:name` | `ex:email` |
| --- | --- | --- |
| Alice | one string | two strings |
| Bob | one string | one string |
| Carol | one string | absent |

For `name`, the counts are `[1, 1, 1]`. Propose a required, single string. For `email`, the counts are `[2, 1, 0]`. Propose string values, with no minimum or maximum count under the default policy.

```turtle
@prefix ex: <https://example.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:PersonShape a sh:NodeShape ;
    sh:targetClass ex:Person ;
    sh:property [
        sh:path ex:name ;
        sh:datatype xsd:string ;
        sh:minCount 1 ;
        sh:maxCount 1
    ] ;
    sh:property [
        sh:path ex:email ;
        sh:datatype xsd:string
    ] .
```

This excerpt shows the two properties in the table. Extraction also examines `rdf:type`; it does not close the shape against other properties. An optional stricter policy could propose `sh:maxCount 2` for email, using the largest observed count. I propose leaving that policy off by default because the observed maximum gives little evidence of an intended limit.

## What we borrow

From **sheXer**, take the method of collecting per-instance observations before selecting constraints. From **SHACL Play**, take the separate rules for presence, maximum-one cardinality, node kind, and datatype. Implement these rules over shared JavaScript maps and sets, so local extraction does not need a SPARQL engine.

Current status: source review and proposed contract. There is no JavaScript implementation or performance benchmark yet.

The [Haskell manifest](../spec/manifest.hs) separates graph selection, indexing, profiling, constraint inference, RDF emission, and external validation. It follows the signature-level style of the rdf-cli manifest. Its functions are specification stubs.

## Ideas to retain

| Source | Algorithm | Decision |
| --- | --- | --- |
| sheXer | Build instance features, then aggregate class/property/value-type/cardinality frequencies. | Retain the separation between observations and shape selection. Count total property values separately from type-specific features. |
| sheXer | Rank constraints by observed frequency and generalize cardinalities. | Retain evidence counts. Defer threshold-based rejection of outliers until joint shape support is measured. |
| SHACL Play | Separate visitors infer node kinds, datatypes, classes, and cardinalities. | Retain independent inference functions; replace repeated SPARQL queries with shared indexes for local data. |
| SHACL Play | Detect missing properties and distinct pairs to propose minimum 1 and maximum 1. | Use these bounds as the first policy; keep exact observed extrema optional. |
| SHACL Play | Cache sampled instances when endpoint queries fail. | Endpoint support is required. Specify query completeness and make sampling explicit. |

## Source findings

Reviewed local snapshots: sheXer `bfa82aebe8479eb42f5dfba054f221c72e7c21d3`; SHACL Play `996de4ea5c9a1c05f0fa68e59c27b2cdc669161a`. Findings apply to these checkouts; neither library was executed.

- sheXer's [profiler](../research/shexer/shexer/core/profiling/class_profiler.py) separates instance annotation from class aggregation. Its [feature strategy](../research/shexer/shexer/core/profiling/strategy/abstract_feature_direction_strategy.py) records exact cardinality and positive closure. These are useful observations, but overlapping type categories cannot be summed to obtain property cardinality.
- Its [selection strategy](../research/shexer/shexer/core/shexing/strategy/abstract_shexing_strategy.py) divides feature occurrences by class population, groups candidates, and weakens cardinalities in all-compliant mode. A per-constraint ratio does not establish whole-shape conformance.
- Its [SHACL serializer](../research/shexer/shexer/io/shacl/formater/shacl_serializer.py) defines and emits `sh:dataType` instead of `sh:datatype`. Its macro table maps the wildcard to BlankNode and BNode to no constraint. These are concrete source defects; do not copy this serializer. An incorrect `rdfs:langString` constant also exists, but the inspected use is commented out.
- SHACL Play's [cardinality visitor](../research/shacl-play/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/visitors/AssignMinCountAndMaxCountVisitor.java) uses absence tests for minimum 1 and distinct-pair tests for maximum 1. Its query uses `sameTerm`, correctly preserving RDF term identity when comparing values.
- Its [class visitor](../research/shacl-play/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/visitors/AssignClassesVisitor.java) reduces classes using observed co-occurrence and emits class alternatives. The [object-type query](../research/shacl-play/shacl-generate/src/main/resources/shacl/generate/select-object-types.rq) only returns typed objects. Thus this method alone cannot establish that every value satisfies a class constraint when untyped values are also present. Prefer the intersection of classes across all resource values for v1.
- Its [enumeration visitor](../research/shacl-play/shacl-generate/src/main/java/fr/sparna/rdf/shacl/generate/visitors/AssignValueOrInVisitor.java) emits `sh:hasValue` for a singleton observed value set. Singleton range does not prove mandatory presence: a subject missing that property would fail. Defer enumeration inference.

## Proposed algorithm

For each class C and property p, let V(s,p) be the set of distinct RDF values for subject s. Record H(k), the number of target subjects for which |V(s,p)| = k. Include missing properties: H(0) is population minus the number of subjects with p.

Example: three subjects have 2, 1, and 0 values. H = {0:1, 1:1, 2:1}; property presence is 2/3. The default policy proposes neither minimum 1 nor maximum 1. The optional extrema policy proposes maximum 2. Neither policy proves a domain rule for future data.

Build value alternatives per value, not per subject. If a property has both strings and integers, use a property shape whose value constraint is an OR of those datatypes. Preserve a resource branch for untyped resources. Use common classes only when every resource value has them. Do not infer recursive `sh:node` links from class membership.

Require explicit graph selection. Per-graph extraction yields separate shape sets and separate validation runs. A union is an explicit projection that deduplicates repeated triples. Resolve subclass membership within that same graph so target populations match `sh:targetClass` semantics. These choices follow the [SHACL Recommendation](https://www.w3.org/TR/shacl/), particularly class targets, cardinality, datatype and logical constraints.

Keep the core independent of parsers, serializers, SPARQL engines, and validators. Accept RDF/JS quads and a caller-supplied factory; return shape quads plus evidence. The existing validator can check proposals through an adapter. Its exact package/API has not been established here.

## Implementation acceptance cases

Check duplicate quads; shuffled input with late type declarations; missing properties; multiple values and multiple types; mixed literal/resource values; untyped objects; subclass cycles; identical triples in different graphs; empty target classes; language-tagged literals; and invalid datatype lexical forms. Verify emitted shapes with the existing validator, including negative examples that must fail. A positive training-data check alone cannot detect silently ignored predicates such as `sh:dataType`.

No runtime or memory measurements have been made. The proposed local algorithm retains indexes; it is not a constant-memory streaming algorithm. Sampling, structural clustering of untyped subjects, inverse paths, recursive shapes, enumerations, and statistical outlier policies remain later extensions.
