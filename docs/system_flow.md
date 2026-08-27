# System flow

The product workflow from [`PRODUCT.md`](PRODUCT.md). `createRunContext`
computes spanning tree before any frame exists. `send` originates from a
host or other sender and ARPs only when that sender lacks its next-hop MAC.
`walkFrame` follows links and dispatches each arrival on `Port.ownedBy`.
`bridgeFrame` is one hop through one bridging function; `routeFrame` is one
hop through one routing function.

```mermaid
flowchart TD
    A[Describe the topology as data] --> C[createRunContext]
    C --> D[Converged STP state]
    D --> S[send from a sender]
    S --> P{Next-hop MAC<br>known?}
    P -->|no, and needed| AR[ARP request is a frame]
    AR --> Q[walkFrame queue]
    P -->|yes or not needed| Q
    D --> W{Parallel trunks<br>two or more VLANs?}
    W -->|yes| X[ADR 0011 warning<br>not a Hop]
    W -->|no| Q
    X --> Q
    Q --> B{hopsLeft?}
    B -->|0| Z[hop-budget hop]
    B -->|yes| E[executor for ownedBy<br>or host delivery]
    E --> F[One or more Hops per pass]
    F --> T[Enqueue every transmission]
    T --> B
    Z --> G[format turns hops and traces into sentences]
    F --> G
    G --> H[Caller reads the trace]
    I[Wording test] --> G
    I --> J[catalogue.ts row]
    style C fill:#d7f5d7,color:#000
    style D fill:#d7f5d7,color:#000
    style E fill:#d7f5d7,color:#000
    style Q fill:#d7f5d7,color:#000
    style G fill:#d7f5d7,color:#000
    style H fill:#d7f5d7,color:#000
```

A drop is an outcome, not an error. The hop names the pipeline step that
produced it. There is no pass/fail field on a hop.

A flow — request plus reply sharing one run context — is how rows 9, 13 and
15 are seen. That driver is #7.
