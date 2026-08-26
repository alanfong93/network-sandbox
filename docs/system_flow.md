# System flow

The product workflow from [`PRODUCT.md`](PRODUCT.md). The engine call is a
hole until #3–#7 land; `format` and the catalogue already sit at the end of
it, which is why they shipped first.

```mermaid
flowchart TD
    A[Describe the topology as data] --> B{Engine<br>not yet built}
    B -->|#3 onwards| C[One run context]
    C --> D[Converged STP state]
    D --> E[Frame walks the 802.1Q pipeline]
    E --> F[Each chassis appends a Hop]
    F --> G[format turns hops into sentences]
    G --> H[Caller reads the trace]
    I[Wording test] --> G
    I --> J[catalogue.ts row]
    style B fill:#ffe9cc,color:#000
    style G fill:#d7f5d7,color:#000
    style H fill:#d7f5d7,color:#000
```

A drop is an outcome, not an error. The hop names the pipeline step that
produced it. There is no pass/fail field on a hop.

A flow — request plus reply sharing one run context — is how rows 9, 13 and
15 are seen. That driver is #7.
