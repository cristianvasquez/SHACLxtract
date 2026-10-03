-- | Algorithm contract for SHACLxtract, at signature level.
-- Normative specification of the JS implementation in src/. It typechecks
-- (ghc -fno-code spec/manifest.hs); it is not executable.
-- Style follows rdf-cli/spec/manifest.hs.
--
-- Input: RDF instance data (local dataset or SPARQL endpoint).
-- Output: candidate SHACL shapes. Evidence and notices stay internal in v1.
--
-- Pipeline:
--   local:    selectGraphs -> profile         -> propose -> nameShapes -> emit
--   endpoint:                  profileEndpoint -> propose -> nameShapes -> emit
--
-- Manifest                        JS
--   Options, Scope                  src/index.js normalizeOptions, src/scope.js normalizeScope
--   selectGraphs                    src/scope.js selectGraph
--   profile                         src/profile.js profileGraph
--   inferBounds, inferValues,       src/propose.js
--   propose
--   nameShapes, emit                src/emit.js
--   profileEndpoint                 src/endpoint.js
--   extractShapes,                  src/index.js (public API)
--   extractShapesFromEndpoint
--
-- Example: Person instances Alice, Bob, Carol have name counts [1,1,1]
-- and email counts [2,1,0]. Both properties contain only xsd:string values.
--   name:  Histogram {1 -> 3}; minCount 1, maxCount 1, datatype xsd:string.
--   email: Histogram {0 -> 1, 1 -> 1, 2 -> 1}; datatype xsd:string only.
-- The default rule does not infer maxCount 2 from the email sample.
-- See readme.md for the corresponding SHACL output.
module SHACLxtract.Manifest where

import Data.Map.Strict (Map)
import Data.Set (Set)
import Numeric.Natural (Natural)

type Iri = String
data Resource = IRI Iri | Blank String deriving (Eq, Ord, Show)
data Value = Resource Resource | Literal String Iri (Maybe String)
  deriving (Eq, Ord, Show)
data Graph = DefaultGraph | NamedGraph Iri deriving (Eq, Ord, Show)
data Quad = Quad Resource Iri Value Graph deriving (Eq, Ord, Show)
type Dataset = Set Quad
type Triple = (Resource, Iri, Value)

-- Graph selection is required. There is no implicit union.
-- Union deduplicates triples across the selected graphs.
-- To keep graphs separate, the caller runs extraction once per graph.
-- JS: { type: 'default' } | { type: 'named', iri } | { type: 'union', graphs }.
-- A union is a non-empty list of default/named selections, not nested unions.
data Scope = OneGraph Graph | UnionGraphs (Set Graph)
data ScopedGraph = ScopedGraph
  { sourceGraphs :: Set Graph
  , triples :: Set Triple
  }
selectGraphs :: Scope -> Dataset -> ScopedGraph

-- Discover classes from IRI-valued rdf:type objects, or select them explicitly.
-- Membership of a resource: IRIs reachable by rdf:type/rdfs:subClassOf* in the
-- selected graph, matching sh:targetClass. No general RDFS/OWL entailment.
-- Closure terminates on subclass cycles. Never borrow types from other graphs.
-- Read all types before classifying object values: input order is arbitrary.
data Targets = DiscoverClasses | Classes (Set Iri)

-- A property histogram counts DISTINCT RDF terms per focus node.
-- Lexically different typed literals remain different terms.
-- Every target contributes once, including a zero for a missing property.
type Histogram = Map Natural Natural -- value count -> number of focus nodes
data NodeKind = IsIRI | IsBlank | IsLiteral deriving (Eq, Ord, Show)
data PropertyProfile = PropertyProfile
  { population :: Natural
  , counts :: Histogram
  , kinds :: Set NodeKind
  , datatypes :: Set Iri
  , commonClasses :: Set Iri
  , resourceValues :: Natural
  , untypedResources :: Natural
  }
-- resourceValues = number of distinct IRI and blank-node values.
-- commonClasses = intersection of memberships over ALL resource values;
-- empty when resourceValues = 0. An untyped resource contributes the empty
-- set, not an omitted observation. Memberships include superclass closure,
-- so the intersection holds superclasses too; inferValues reduces it.
-- Cardinalities count values once even when each value has several classes.
data ClassProfile = ClassProfile
  { classPopulation :: Natural
  , propertyProfiles :: Map Iri PropertyProfile
  }
-- For each class in any commonClasses: the common classes it is a subclass
-- of (rdfs:subClassOf*, itself included). inferValues needs only this subset.
type SuperClasses = Map Iri (Set Iri)
data Profile = Profile
  { classProfiles :: Map Iri ClassProfile
  , unclassifiedSubjectCount :: Natural
  , superClasses :: SuperClasses
  }
-- Properties = union of outgoing predicates across the class's instances,
-- including rdf:type. Do not invent absent properties from an ontology.
-- Retain explicitly selected empty classes with population 0 and no properties.
-- unclassifiedSubjectCount counts distinct subjects with empty memberships,
-- regardless of which classes the caller selected.
profile :: Targets -> ScopedGraph -> Profile

-- Collect observations first; choose constraints afterwards.
-- Default: presence/singleton bounds. Exact observed extrema are opt-in.
-- JS: 'presence-and-singleton' | 'observed-extrema' | 'none'.
data CountPolicy = PresenceAndSingleton | ObservedExtrema | NoCounts
data Policy = Policy { countPolicy :: CountPolicy, excludedProperties :: Set Iri }
-- propose emits no property shape for an excluded path. The profile still observes it.

-- One value expression applies independently to EACH property value.
-- Several datatype alternatives become sh:or within the property shape.
-- Never put alternatives of entire properties around heterogeneous values.
-- Kind takes a set: SHACL has combined kinds (sh:BlankNodeOrIRI, etc.).
data ValueRule
  = AnyValue
  | Kind (Set NodeKind)
  | Datatype Iri
  | Class Iri
  | AllOf [ValueRule]
  | AnyOf [ValueRule]
  deriving (Eq, Show)
data Bounds = Bounds { lower :: Maybe Natural, upper :: Maybe Natural }
  deriving (Eq, Show)
data PropertyShape = PropertyShape
  { path :: Iri
  , bounds :: Bounds
  , valueRule :: ValueRule
  , evidence :: PropertyProfile
  }
data NodeShape = NodeShape
  { targetClass :: Iri
  , targetPopulation :: Natural
  , properties :: [PropertyShape]
  }
data Proposal = Proposal { shapes :: [NodeShape], notices :: [Notice] }
data Notice = EmptyTarget Iri | UnclassifiedSubjects Natural | DatatypeUnchecked Iri

-- rdf:type gets no bounds under any policy: multi-typing is common, and
-- maxCount 1 observed on rdf:type rejects any later second type.
-- propose applies this; inferBounds itself does not know the path.
-- For N > 0 and at least one observed value:
-- PresenceAndSingleton: minCount 1 iff H[0]=0; maxCount 1 iff max(keys H)<=1.
-- ObservedExtrema: use min/max keys H, omit zero minimum.
-- Empty populations never create vacuously mandatory properties.
-- Absent histogram entries mean 0; stored frequencies must be positive.
-- Empty and zero-only histograms return Nothing: no observed property to emit.
-- Otherwise NoCounts returns Just (Bounds Nothing Nothing): emit the property
-- with its value rule, but without count constraints.
inferBounds :: CountPolicy -> Histogram -> Maybe Bounds

-- Literal branch: one Datatype rule per observed datatype.
-- Resource branch: node kind (IRI, blank node, or both), AND the most specific
-- common classes. Mixed values: AnyOf over all literal and resource branches.
-- Most specific: drop c when another member d is a subclass of c and c is not
-- a subclass of d (keeps all members of a subclass cycle).
-- Several common classes are a conjunction: AllOf [Kind ks, Class c1, Class c2].
-- No sh:node recursion, closed shapes, enums, or regex inference in v1.
inferValues :: SuperClasses -> PropertyProfile -> ValueRule

-- Shapes sorted by class IRI, property shapes by path IRI.
-- Emit an empty NodeShape and EmptyTarget notice for each selected empty class.
-- Emit UnclassifiedSubjects only when unclassifiedSubjectCount > 0.
-- Emit DatatypeUnchecked once per datatype used by a proposed Datatype rule:
-- inference reads datatype IRIs but does not check literal lexical validity.
propose :: Policy -> Profile -> Proposal

-- Shape naming: the caller supplies a function from class IRI to shape IRI.
-- Default: append "Shape" to the class IRI.
-- usedIris: IRIs that occur in the selected source graph (endpoint: a VALUES
-- query over the candidate shape IRIs, in scope).
type ShapeNaming = Iri -> Iri
data NamingError = Collision Iri Iri Iri | AlreadyUsed Iri Iri | NoIri Iri
nameShapes :: ShapeNaming -> Set Iri -> [Iri] -> Either NamingError (Map Iri Iri)

-- Output goes to the default graph of a new dataset, whatever the source scope.
-- The JS implementation uses rdf-ext terms, term sets/maps, and datasets.
-- Use sh:datatype (lowercase t), rdf:langString, and well-formed RDF lists.
-- Stable ordering; output equality is up to blank-node renaming.
-- Every NodeShape gets rdf:type sh:NodeShape and sh:targetClass.
-- Every property gets sh:property linkage and sh:path; emit each present bound.
-- ValueRule mapping at the property/value shape node:
--   AnyValue   -> no value constraint
--   Kind ks    -> sh:nodeKind of the matching SHACL kind:
--                 {IRI} sh:IRI, {Blank} sh:BlankNode, {Literal} sh:Literal,
--                 {IRI,Blank} sh:BlankNodeOrIRI, {IRI,Literal} sh:IRIOrLiteral,
--                 {Blank,Literal} sh:BlankNodeOrLiteral; all three -> none
--   Datatype d -> sh:datatype d
--   Class c    -> sh:class c
--   AllOf rs   -> if no member is AllOf/AnyOf, and at most one member is a
--                 Datatype and at most one a Kind: all constraints on the same
--                 node (constraints of one shape are conjunctive; several
--                 sh:class values are valid). Otherwise sh:and RDF list.
--   AnyOf rs   -> sh:or RDF list of fresh shapes, one per rule
-- Normalize singleton combinations to their member, and flatten nested
-- combinations of the same type. Empty combinations are prohibited in
-- proposals; use AnyValue for an unconstrained value instead.
-- Fresh blank nodes for property shapes, value shapes and list cells are
-- distinct from the given input blank nodes (local: all blank nodes of the
-- input dataset; endpoint: none). Evidence stays in the returned proposal;
-- emit does not invent an RDF evidence vocabulary.
emit :: Set Resource -> Map Iri Iri -> Proposal -> Dataset

-- Endpoint adapter: build the same Profile with SPARQL aggregate queries,
-- then reuse propose, nameShapes and emit. Only aggregates cross the network.
-- Protocol: SPARQL 1.1 POST, application/sparql-query, JSON results.
-- JS options: fetch (injectable), headers (for example authorization),
-- timeout per query in milliseconds (default 60000).
-- Graph scope: OneGraph DefaultGraph queries the endpoint default graph as
-- configured (it can be a union of all graphs, or include inference);
-- NamedGraph and UnionGraphs use FROM clauses; a union with the default graph
-- cannot be expressed with FROM and is rejected before any query (TypeError
-- in JS). Report, do not guess, the endpoint's default-graph and entailment
-- semantics.
-- Discovery: DISTINCT IRI-valued rdf:type objects, in scope.
-- Per target class C (membership: ?s rdf:type/rdfs:subClassOf* C, in scope):
--   population:  COUNT(DISTINCT ?s)
--   histogram:   per ?p, GROUP BY ?k over (?s, COUNT(DISTINCT ?o) AS ?k)
--   kinds and datatypes: DISTINCT isIRI/isBlank/isLiteral, DATATYPE(?o)
--   resourceValues: COUNT(DISTINCT ?o) over non-literal values
--   untypedResources: resource values with no IRI membership in scope
--   commonClasses: class D is common iff the count of distinct resource
--                  values in D equals resourceValues
-- superClasses: one query for rdfs:subClassOf* pairs among common classes.
-- Completeness: fail on HTTP errors, timeouts and invalid JSON (QueryFailed).
-- Endpoints can truncate results without an error, so every multi-row query
-- is checked against a one-row COUNT(*) of the same query; the nonzero
-- histogram entries must not exceed the population; the histogram and kind
-- queries must return the same properties. A mismatch is Incomplete, never a
-- partial result.
-- Limit: an endpoint that truncates silently inside a one-row aggregate
-- (partial "anytime" results) cannot be detected. Data changes between
-- queries are not detected.
-- Equivalence law: for the same stable graph and scope semantics,
-- profileEndpoint and profile . selectGraphs give the same Profile.
-- JS errors: Error with code 'QueryFailed' or 'Incomplete', a message, and
-- the failing query.
type EndpointUrl = String
data EndpointConfig = EndpointConfig
  { endpointUrl :: EndpointUrl
  , headers :: [(String, String)]
  , timeoutMs :: Natural
  }
data EndpointError = QueryFailed String | Incomplete String
profileEndpoint :: EndpointConfig -> Scope -> Targets -> IO (Either EndpointError Profile)

-- Public API. Invalid options fail before any work (TypeError in JS).
-- Validation is the caller's job; the library has no validator dependency.
-- Ill-typed source literals can violate inferred datatype constraints, so
-- conformance of the source data must be checked, never presumed.
data Options = Options
  { scope :: Scope
  , targets :: Targets
  , policy :: Policy
  , naming :: ShapeNaming
  }
data ExtractError = Naming NamingError | Endpoint EndpointError
extractShapes :: Options -> Dataset -> Either ExtractError Dataset
extractShapesFromEndpoint :: EndpointConfig -> Options -> IO (Either ExtractError Dataset)

-- Algorithm:
-- 1. Select graphs and deduplicate triples (local input).
-- 2. Resolve memberships with subclass closure, in the selected graph.
-- 3. Resolve target populations; each multi-typed subject joins each target once.
-- 4. Aggregate nonzero counts and value descriptors for each class/property.
-- 5. Set H[0] = population - sum(nonzero histogram frequencies).
-- 6. Infer independent constraints; retain evidence in the proposal.
-- 7. Name shapes, then emit them.
--
-- Laws (test reference in brackets):
-- * Input permutation and duplicate quads do not change profiles.
--   [extract: duplicate quads and input order]
-- * sum(H) = population; no support division when population = 0.
--   [extract: empty class; endpoint: Incomplete check]
-- * OneGraph g is invariant under additions to any different graph.
--   [extract: additions to other graphs]
-- * Blank-node renaming preserves results up to renaming.
--   [extract: blank-node renaming]
-- * Multi-typing cannot inflate value counts. [extract: multiple types]
-- * Endpoint and local profiles agree. [endpoint: same shapes]
-- * Sample support is an observed ratio, not statistical confidence.
-- * Separately passing constraints need not jointly pass a support threshold.
--
-- Complexity: memory O(T + expanded memberships + profile size), where T is
-- selected distinct triples. The JS implementation scans the selected
-- subjects once per target class, so work is at least O(C * S) for C target
-- classes and S subjects, plus each object's class set per property.
-- Subclass closure adds its own traversal and storage cost.
-- Arbitrary-order input needs materialization. No bounded-memory streaming.

manifestOnly :: a
manifestOnly = error "signature-level specification only"

selectGraphs = manifestOnly
profile = manifestOnly
inferBounds = manifestOnly
inferValues = manifestOnly
propose = manifestOnly
nameShapes = manifestOnly
emit = manifestOnly
profileEndpoint = manifestOnly
extractShapes = manifestOnly
extractShapesFromEndpoint = manifestOnly
