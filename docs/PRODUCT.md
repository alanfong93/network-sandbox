# Who

Someone who administers a small network they are personally responsible for — a
homelab, an SMB, a floor of an office — and who is about to change a VLAN, a trunk,
or a router tier on gear that is currently carrying traffic.

They manage production. That is the qualifier: it is why they have something to lose,
and why "test it here first" means anything to them. Teaching is a *side effect* of
showing the trace, not the target user — a tool aimed at people who don't yet run a
network is a different product with a different failure mode.

# Must be able to

1. Build the topology they actually have — managed and unmanaged switches with their
   market port count, routers at any depth, hosts, DHCP both router-based and
   standalone, a resolver box whose records they edit, and the Internet box their
   names resolve to — with no install, no account, and no server.
2. Make the exact change they are about to make on the real gear.
3. Send a frame — to an address or a name — and see, hop by hop, what happened to it,
   resolver walk included: when it dies, which step of the 802.1Q pipeline killed it,
   in the standard's own terms.
4. Reproduce a named mistake from the failure catalogue (`SPEC.md` §4) and recognise
   it as the one they were worried about.
5. Keep a topology between sessions and hand it to someone else as a file.

# Done when

Someone reproduces their own broken VLAN in the sandbox, reads the hop that killed
the frame, fixes the real switch — and does it alone, without asking anyone.

# Not this project

Telling them **how long** reconvergence takes, or whether sessions survive a failover
— there is no clock ([ADR 0003](adr/0003-converged-state-no-timers.md)).

Vendor CLI syntax, vendor defaults, or **generating** real device config to paste into a
live switch. The sandbox is faithful to IEEE 802.1Q/802.1D, not to any one box. **Reading**
a real device config to build the topology is in scope, through a per-vendor grammar
supplied as profile data
([ADR 0015](adr/0015-import-real-config-before-exporting-it.md)).

Telling them whether an AP covers the far end of the office. That is a site survey,
not a standard ([ADR 0006](adr/0006-radio-is-an-estimate-not-a-result.md)).
Output derived from a standard reads as a trace; anything estimated is marked as
an estimate with its assumptions listed, never as a trace
([ADR 0024](adr/0024-estimates-never-pass-through-format.md)).

Being a certification trainer or a fixed-scenario lesson plan. The topology is the
user's own, or the tool has no advantage over what already exists.
