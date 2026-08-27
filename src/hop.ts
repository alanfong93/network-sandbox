import { format, type HopFacts } from './format';
import type { DeviceId, FnId, Hop, HopAction, VlanId } from './model';
import { reasonCode, type Outcome, type PipelineStep } from './reasons';

export function makeHop(args: {
  device: DeviceId;
  fn?: FnId;
  inPort?: string;
  outPort?: string;
  vlan: VlanId | null;
  action: HopAction;
  step: PipelineStep;
  outcome: Outcome;
  facts?: HopFacts;
}): Hop {
  const reason = format({
    kind: 'hop',
    device: args.device,
    fn: args.fn,
    inPort: args.inPort,
    outPort: args.outPort,
    vlan: args.vlan,
    action: args.action,
    step: args.step,
    outcome: args.outcome,
    facts: args.facts,
  });
  return {
    device: args.device,
    fn: args.fn,
    inPort: args.inPort,
    outPort: args.outPort,
    vlan: args.vlan,
    action: args.action,
    step: args.step,
    reasonCode: reasonCode(args.step, args.outcome),
    reason,
  };
}
