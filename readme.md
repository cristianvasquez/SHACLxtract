# SHACLxtract

A Node.js library that generates SHACL shapes from RDF instance data.

| Input | Output |
| --- | --- |
| An RDF/JS dataset | A new RDF/JS dataset with SHACL shapes |
| A SPARQL endpoint URL | A new RDF/JS dataset with SHACL shapes |

Both inputs give the same observations and the same constraint rules. The source data does not change. The caller can validate, serialize or edit the result.

**Origin:** this library was vibecoded: an AI coding agent wrote the code, the specification and the tests. Two existing SHACL generators were the algorithm examples:

- [sheXer](https://github.com/weso/shexer) (WESO): collect observations for each instance first, then select constraints.
- [SHACL Play](https://github.com/sparna-git/shacl-play) (Sparna): infer cardinality, node kind, datatype and class constraints with separate rules.

No code was copied from them. [`docs/research.md`](docs/research.md) lists the reviewed commits, the ideas taken, and the defects not copied.

**Status:** version 0.1.0. Local and endpoint extraction are implemented and tested (`pnpm test`; shapes are checked with [shacl-engine](https://github.com/rdf-ext/shacl-engine), endpoint results against [Oxigraph](https://github.com/oxigraph/oxigraph)). No performance measurements yet.

## Usage

Requires Node.js 22 or later.

```sh
npm install shaclxtract
```

```js
import { extractShapes, extractShapesFromEndpoint } from 'shaclxtract'

// Dataset already loaded in JavaScript. Synchronous.
const shapes = extractShapes(data, {
  graph: { type: 'default' },
  excludeProperties: ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type']
})

// SPARQL endpoint. Asynchronous.
const shapesFromEndpoint = await extractShapesFromEndpoint('https://example.org/sparql', {
  graph: { type: 'named', iri: 'https://example.org/data' },
  headers: { authorization: 'Bearer …' }
})

// Union of selected graphs, custom shape IRIs.
const shapesFromUnion = extractShapes(data, {
  graph: { type: 'union', graphs: [{ type: 'default' }, { type: 'named', iri: 'https://example.org/more' }] },
  shapeIri: classIri => `https://example.org/shapes/${encodeURIComponent(classIri)}`
})
```

`data` is an RDF/JS dataset or any iterable of quads. The result is an RDF/JS dataset with the shapes in its default graph. Type declarations are in [`src/index.d.ts`](src/index.d.ts).

### Options

| Option | Default | Description |
| --- | --- | --- |
| `graph` | required | `{ type: 'default' }`, `{ type: 'named', iri }` or `{ type: 'union', graphs: [...] }` |
| `classes` | all IRI-valued `rdf:type` objects | Class IRIs to extract. A selected class without instances gives an empty node shape. |
| `excludeProperties` | `[]` | Property IRIs that get no property shape |
| `countPolicy` | `'presence-and-singleton'` | `'presence-and-singleton'`, `'observed-extrema'` or `'none'` (see below) |
| `shapeIri` | class IRI + `Shape` | Function from class IRI to shape IRI |

Endpoint only:

| Option | Default | Description |
| --- | --- | --- |
| `fetch` | `globalThis.fetch` | Fetch implementation |
| `headers` | `{}` | Extra HTTP headers, for example `authorization` |
| `timeout` | `60000` | Timeout per query, in milliseconds |

### Errors

- Invalid options: `TypeError`, before any work.
- Two classes map to the same shape IRI, or a shape IRI already occurs in the source graph: `Error`.
- Endpoint: `Error` with `code` `'QueryFailed'` (HTTP error, timeout, invalid response) or `'Incomplete'` (truncated results), and the failing `query`.

## How extraction works

Graph selection is explicit: the default graph, a named graph, or a union of selected graphs. A union removes repeated triples. To keep graphs separate, run extraction once for each graph.

For each selected class:

1. Find its instances, including instances of declared subclasses (`rdf:type/rdfs:subClassOf*`) in the selected graph.
2. Find the properties used by those instances, including `rdf:type`.
3. Count distinct values of each property for each instance. Count zero when a property is absent.
4. Inspect the values: IRIs, blank nodes, literal datatypes, and classes of resource values.
5. Generate a node shape for the class and property shapes from these observations.

| Observation | Constraint |
| --- | --- |
| All instances have the property | `sh:minCount 1` |
| No instance has more than one value | `sh:maxCount 1` |
| All literal values have one datatype | `sh:datatype` |
| Literal values have several datatypes | `sh:or` of datatype constraints |
| Resource values share a node kind | `sh:nodeKind`, including combined kinds such as `sh:BlankNodeOrIRI` |
| All resource values belong to a class | `sh:class`, most specific classes only |

Count policies:

- `presence-and-singleton` (default): the two count rows above.
- `observed-extrema`: the observed minimum (if above zero) and maximum.
- `none`: no count constraints.

Mixed literal and resource values give `sh:or` alternatives that cover both. One untyped resource value removes `sh:class`. Multiple types on one value do not increase its count. `rdf:type` gets no count constraints: one observed type per instance must not reject a second type later.

The shapes describe the observed data, not requirements for future data. One email per person in the source gives `sh:maxCount 1`, but the application may permit several emails. Literals are not checked for lexical validity: an ill-typed source literal can violate the inferred `sh:datatype`. Validate the source data against the shapes before you use them.

## Example

Input:

```turtle
@prefix ex: <https://example.org/> .

ex:alice a ex:Person ; ex:name "Alice" ; ex:email "a@x.org", "alice@x.org" .
ex:bob   a ex:Person ; ex:name "Bob"   ; ex:email "bob@x.org" .
ex:carol a ex:Person ; ex:name "Carol" .
```

Output, serialized as Turtle:

```turtle
@prefix ex: <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:PersonShape a sh:NodeShape ;
    sh:targetClass ex:Person ;
    sh:property [
        sh:path ex:email ;
        sh:datatype xsd:string
    ] ;
    sh:property [
        sh:path ex:name ;
        sh:datatype xsd:string ;
        sh:minCount 1 ;
        sh:maxCount 1
    ] ;
    sh:property [
        sh:path rdf:type ;
        sh:nodeKind sh:IRI
    ] .
```

## SPARQL endpoints

The endpoint adapter computes the same observations with SPARQL aggregate queries (SPARQL 1.1 protocol, POST, JSON results). Only aggregates cross the network. Shapes are then generated locally with the same rules. For an equivalent, stable graph, endpoint and local extraction give the same shapes, up to blank-node labels.

- The endpoint's default graph is used as configured. It can be a union of all graphs or include inference; extraction does not guess.
- Named graphs and unions use `FROM`. A union that includes the default graph cannot be expressed with `FROM` and is rejected.
- Endpoints can truncate results without an error. Each multi-row result is compared with a one-row `COUNT(*)` of the same query; a mismatch is an `Incomplete` error.

Known limits: truncation inside a one-row aggregate cannot be detected, and data changes between queries are not detected. There is no sampling.

## Development

```sh
pnpm install
pnpm test
pnpm check:spec   # typechecks the manifest, needs GHC
```

## Specification and research

- [`spec/manifest.hs`](spec/manifest.hs): the algorithm contract as Haskell types and signatures, with a map to the JS modules. It typechecks with `ghc -fno-code spec/manifest.hs`; it is not executable.
- [`docs/research.md`](docs/research.md): review of sheXer and SHACL Play at fixed commits, with links to the source files.

The core does not depend on parsers, serializers, SPARQL engines or validators. Local extraction does not need a SPARQL engine.

## License

[MIT](LICENSE)
