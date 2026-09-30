# OptMem vs engram: memory generation, recall, and aging

Snapshots: OptMem [`1fb164c`](https://github.com/VictorTaelin/OptMem/tree/1fb164cf39028047781f72ac3bb1e5a691c1dcb0)
(`memo`, `test.py`, `README.md`); engram `349e40f`.

Node labels name the actor:

- **[Human]** — a person acts. Dashed human nodes are optional and depend on host policy;
  neither runtime has a built-in human approval step.
- **[Agent]** — the model working in the session decides or acts.
- **[Automatic]** — the tool or harness acts with no judgment call.

## 1. OptMem — generate and compress

```mermaid
flowchart TD
    H["[Human] conversation with the main agent"] --> A["[Agent] main agent: new and lasting?"]
    S["[Agent] subagent"] -.->|"prompt says never run memo, not enforced"| A
    A -->|"memo note: one line, max 280 bytes, no approval step"| L[("[Automatic] LOG.txt: append-only, raw entries never change")]
    L --> P{"[Automatic] a complete block not yet summarised?"}
    P -->|yes| J["[Automatic] note output ends with the next summary job"]
    J --> N["[Agent] memo nap: one-line summary, never reviewed"]
    N --> T[("[Automatic] summary tree: derived cache, rebuildable from the log")]
    T --> P
    F["[Human] or [Agent] memo forget lo-hi"] -.->|"drops that summary and those built on it, log untouched"| T

    classDef human fill:#fde2e4,stroke:#b03a2e,color:#000
    classDef agent fill:#dbeafe,stroke:#1d4ed8,color:#000
    classDef auto fill:#eeeeee,stroke:#555555,color:#000
    class H,F human
    class A,S,N agent
    class L,P,J,T auto
```

Blocks of 16 memories or fewer are summarised from raw entries; larger blocks from their two
half-summaries. Summary work totals fewer than T summaries for T memories, and one note triggers
at most about log2(T).

## 2. OptMem — wake and recall; only the view ages

```mermaid
flowchart TD
    S["[Agent] session start: memo wake, required by the prompt"] --> C["[Automatic] fixed 96-line view: block shown whole only if size is at most alpha x age"]
    C --> M{"[Automatic] a summary the view needs is missing?"}
    M -->|yes| NAP["[Agent] memo nap, then wake again"] --> C
    M -->|no| V["[Automatic] view: newest verbatim, older inside ever larger summaries"]
    V -->|"need detail"| Z["[Agent] memo zoom: halve down to raw entries"]
    V -->|"know a word, date or id"| R["[Agent] memo recall: regex over the full raw log"]

    subgraph AGE["[Automatic] view only: where memory 100 appears; its raw entry never changes"]
      direction LR
      A1["101 memories: verbatim"] --> A2["500: in a 16-entry summary"] --> A3["2,000: 128"] --> A4["100,000: 8,192"]
    end

    classDef agent fill:#dbeafe,stroke:#1d4ed8,color:#000
    classDef auto fill:#eeeeee,stroke:#555555,color:#000
    class S,NAP,Z,R agent
    class C,M,V,A1,A2,A3,A4 auto
```

Wake layout at 2,000 memories, oldest to newest (96 lines): 4×128, 12×64, 11×32, 12×16, 11×8,
11×4, 9×2, 26×1. Computed with the pinned `cover()`.

## 3. engram — generate (ambient and explicit)

```mermaid
flowchart TD
    U["[Human] user message"] --> HK["[Automatic] turn ends: session_stop hook"]
    HK --> TC["[Automatic] narrative = latest user message; tool calls and results kept as provenance"]
    TC --> PK["[Automatic] pack captureFromTurn, may call a headless model"]
    PK -->|"create-only file, no reconcile, no approval step"| R[("records/id.md")]

    AG["[Agent] engram_capture_preview with a change set"] --> RC["[Automatic] reconcile against related records: plan + hash, nothing written"]
    RC --> G{"[Agent] engram_capture_apply plan_hash"}
    OPT["[Human] optional, host policy: gate the tool or run CLI approve"] -.-> G
    G -->|"not applied or stale"| X["[Automatic] no change"]
    G -->|applied| TX["[Automatic] lock, recheck, atomic write, reindex"]
    TX --> R

    classDef human fill:#fde2e4,stroke:#b03a2e,color:#000
    classDef optional fill:#fde2e4,stroke:#b03a2e,stroke-dasharray:5 5,color:#000
    classDef agent fill:#dbeafe,stroke:#1d4ed8,color:#000
    classDef auto fill:#eeeeee,stroke:#555555,color:#000
    class U human
    class OPT optional
    class AG,G agent
    class HK,TC,PK,R,RC,X,TX auto
```

## 4. engram — pull recall; lifecycle state instead of aging

```mermaid
flowchart TD
    S["[Automatic] session start: space selected, nothing loaded"] --> Q["[Agent] engram recall or render, only if it knows to ask"]
    D["[Human] authors views, audiences, deliveries at setup"] -.-> F
    Q --> F["[Automatic] search this space only; check current file, source class, relevance, audience"]
    F --> O["[Automatic] records or a rendered view, plus a receipt"]

    subgraph STATUS["No time-based aging: status changes only by explicit hash-bound updates"]
      C1["candidate"] -->|"[Agent] exact plan hash; [Human] optional, host policy"| A1["active"]
      A1 -->|contradicted| CT["contested"]
      CT -->|reconciled| A1
      C1 --> RT["retired: final, reason kept"]
      A1 --> RT
      CT --> RT
    end

    classDef human fill:#fde2e4,stroke:#b03a2e,color:#000
    classDef agent fill:#dbeafe,stroke:#1d4ed8,color:#000
    classDef auto fill:#eeeeee,stroke:#555555,color:#000
    classDef state fill:#fef9c3,stroke:#a16207,color:#000
    class D human
    class Q agent
    class S,F,O auto
    class C1,A1,CT,RT state
```

## Caveats

- **OptMem:** the raw log stays exact. Summaries are derived cache records that `memo forget`
  can drop and a later `nap` rebuilds; `recall` and `zoom` recover raw detail. The subagent ban is
  prompt text only.
- **engram status:** every status change on an existing record needs the exact plan hash. Creating
  a record does not, and the core does not force new records to start as `candidate`, so a pack
  can create `active` records directly — including on the ambient path, where the host does not
  inspect file content.
- **engram recall** is a CLI command, not one of the adapter's registered tools
  (`engram_status`, `engram_capture_preview`, `engram_capture_apply`).
- **Unconfirmed:** whether engram's `session_stop` hook runs in subagent sessions.
