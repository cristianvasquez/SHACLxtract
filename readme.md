# SHACLxtract

A Node.js library to generate SHACL shapes from RDF data.

The objective is to support two inputs and return the same output:

| Input | Output |
| --- | --- |
| An RDF/JS dataset | A new RDF/JS dataset containing SHACL shapes |
| A SPARQL endpoint URL | A new RDF/JS dataset containing SHACL shapes |

The caller can pass the resulting dataset to a SHACL validator, serialize it, or edit it. Extraction leaves the source data unchanged.

**Status:** first implementation in [`src/`](src/), tested with `pnpm test` (local and endpoint extraction, validated with shacl-engine). No performance measurements yet.

## API

```js
// Generate shapes from a dataset already loaded in JavaScript.
const shapes = await extractShapes(data, {
  graph: { type: 'default' }
});

// Generate shapes from data available through a SPARQL endpoint.
const shapesFromEndpoint = await extractShapesFromEndpoint(endpointUrl, {
  graph: { type: 'named', iri: 'https://example.org/data' }
});

// Union of selected graphs; optional shape naming.
const shapesFromUnion = await extractShapes(data, {
  graph: { type: 'union', graphs: [{ type: 'default' }, { type: 'named', iri: 'https://example.org/more' }] },
  shapeIri: classIri => `https://example.org/shapes/${encodeURIComponent(classIri)}`
});
```

`data` and all results are RDF/JS datasets. Both functions return the shapes dataset directly. The observation counts and notices stay internal in v1. Function names and options remain subject to implementation review.

Shape IRIs default to the class IRI with `Shape` appended. `shapeIri` replaces this rule. Extraction fails if two classes get the same shape IRI, or if a shape IRI already occurs in the source graph.

Graph selection is explicit: use the default graph, a named graph, or a union of selected graphs. An endpoint's default graph follows its configured dataset semantics. To keep graphs separate, run extraction once for each graph. Generated shape quads go in the output dataset's default graph.

## How extraction works

For each selected class:

1. Find its instances, including instances of declared subclasses within the selected graph.
2. Find the properties used by those instances, including `rdf:type`.
3. Count distinct values of each property for each instance. Count zero when a property is absent.
4. Inspect the values: IRIs, blank nodes, literal datatypes, and resource classes.
5. Generate a node shape for the class and property shapes from these observations.

The initial constraint rules are:

| Observation | Proposed constraint |
| --- | --- |
| All instances have the property | `sh:minCount 1` |
| No instance has more than one value | `sh:maxCount 1` |
| All values have one literal datatype | `sh:datatype` |
| Values have several literal datatypes | `sh:or` of datatype constraints |
| Values share a node kind | `sh:nodeKind`, including combined kinds such as `sh:BlankNodeOrIRI` |
| All resource values belong to a class | `sh:class` on the resource branch, most specific classes only |

For mixed literal and resource values, generate alternatives that cover both. An untyped resource must remain allowed. Multiple types on one value must not increase its cardinality. `rdf:type` gets no count constraints: one observed type per instance must not reject a second type later.

These shapes describe the observed data. An observed pattern does not establish a requirement for future data. For example, one email per person in the source can suggest `sh:maxCount 1`, but the application may permit several emails.

## Example

Suppose the input contains three people:

| Person | Name values | Email values |
| --- | --- | --- |
| Alice | one string | two strings |
| Bob | one string | one string |
| Carol | one string | none |

The generated shapes require one string name. Email values must be strings, but the initial rules impose no minimum or maximum count.

The returned JavaScript dataset contains RDF quads. Serialized as Turtle, the relevant part would look like this:

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

## Local data and endpoints

Both input methods must collect the same observations and apply the same constraint rules.

For a local dataset, use JavaScript indexes to group instances and count values. For an endpoint, use SPARQL aggregate queries to obtain the same observations, then generate the shapes locally. Only aggregates cross the network. The manifest specifies the queries per class: population, per-property count histogram, node kinds, datatypes, and common classes.

For equivalent, stable source graphs, both methods should produce equivalent shapes, allowing different blank-node identifiers. An endpoint's default graph can be a union of all graphs or include inference; extraction uses it as configured and does not guess. A failed or timed-out query is an error. Endpoints can truncate results without an error, so extraction compares each multi-row result with a one-row `COUNT(*)` of the same query; a mismatch is an error. Partial results inside a one-row aggregate cannot be detected. For endpoints, a union cannot include the default graph. Authentication, and data changes between queries, still need specification. Sampling, if added, must be an explicit option.

## Design and research

Keep the extraction core separate from parsing, serialization, and validation. The caller can validate the generated shapes with the existing validator. Local extraction should not require a SPARQL engine.

We use two projects as algorithm references:

- **sheXer:** collect per-instance observations before selecting constraints.
- **SHACL Play:** infer cardinality, node kind, datatype, and class constraints with separate rules.

See the [research findings](docs/research.md) for source references and identified defects. The [Haskell manifest](spec/manifest.hs) specifies the algorithm and the endpoint adapter. It contains type signatures and contracts, not an implementation.
