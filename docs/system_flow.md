# System flow

The product workflow from [`PRODUCT.md`](PRODUCT.md). `createRunContext`
computes spanning tree before any frame exists. The 802.1Q pipeline itself
is still a hole (#4, #5).

```mermaid
flowchart TD
    A[Describe the topology as data] --> C[createRunContext]
    C --> D[Converged STP state]
    D --> W{Parallel trunks<br>two or more VLANs?}
    W -->|yes| X[ADR 0011 warning<br>not a Hop]
    W -->|no| E[Frame walks the 802.1Q pipeline]
    X --> E
    E --> F[Each chassis appends a Hop]
    F --> G[format turns hops and warnings into sentences]
    G --> H[Caller reads the trace]
    I[Wording test] --> G
    I --> J[catalogue.ts row]
    style C fill:#d7f5d7,color:#000
    style D fill:#d7f5d7,color:#000
    style E fill:#ffe9cc,color:#000
    style G fill:#d7f5d7,color:#000
    style H fill:#d7f5d7,color:#000
```

A drop is an outcome, not an error. The hop names the pipeline step that
produced it. There is no pass/fail field on a hop.

A flow — request plus reply sharing one run context — is how rows 9, 13 and
15 are seen. That driver is #7.
