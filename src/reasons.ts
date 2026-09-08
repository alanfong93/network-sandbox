/**
 * Reason codes are the product of pipeline step × outcome.
 * Adding a code requires adding a step or an outcome, never a scenario (ADR 0001).
 */

export const PIPELINE_STEPS = [
  'origin',
  'acceptable-frame-types',
  'pvid-assignment',
  'ingress-filtering',
  'stp-ingress',
  'source-learning',
  'destination-lookup',
  'hop-budget',
  'stp-egress',
  'egress-membership',
  'egress-tagging',
  'arp',
  'route-lookup',
  'firewall',
  'nat',
  'port-forward',
  'dhcp-server',
  'dhcp-relay',
  'isp-handoff',
  'mtu',
  'delivery',
  'ssid-vlan',
] as const;

export const OUTCOMES = [
  'forwarded',
  'flooded',
  'dropped',
  'delivered',
  'admitted',
  'classified',
  'learned',
  'translated',
  'relayed',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type ReasonCode = `${PipelineStep}:${Outcome}`;

type Product = `${PipelineStep}:${Outcome}`;
export type ReasonCodeIsProduct = ReasonCode extends Product
  ? Product extends ReasonCode
    ? true
    : false
  : false;
export const reasonCodeIsProduct: ReasonCodeIsProduct = true;

export function reasonCode(step: PipelineStep, outcome: Outcome): ReasonCode {
  return `${step}:${outcome}`;
}
