import type { ExplorationContext, ExplorationRun, ExplorationModelCall } from '../../src/exploration/types.js';
export interface StageView {id:string;label:string;status:string;call:ExplorationModelCall|ExplorationRun|null;model:string|null;durationMs:number|null;legacy:boolean}
export function deriveStages(run:ExplorationRun|null):StageView[];
export function buildTimeline(run:ExplorationRun|null,nowMs?:number):{totalMs:number|null;bars:{role:string;model:string;status:string;startMs:number;durationMs:number;endMs:number;left:number;width:number;live:boolean}[];otherMs:number|null;unrecorded:number;live:boolean};
export function contextBreakdown(context:ExplorationContext|null|undefined):{total:number;segments:{id:string;label:string;kind:string;characters:number;percent:number;text:string;reason:string}[]};
export function compareContexts(before:ExplorationContext|null|undefined,after:ExplorationContext|null|undefined):{id:string;title:string;kind:string;status:string;before:string|null;after:string|null;reason:string}[];
export function runOutcome(run:ExplorationRun|null):{committed:boolean;from:{id:string;name:string};to:{id:string;name:string};groups:{regionId:string;name:string;changes:{kind:string;label:string;before:string|null;after:string|null}[]}[];changeCount:number};
export function filterRuns(runs:ExplorationRun[],filter?:{status?:string;query?:string}):ExplorationRun[];
export function runMetrics(run:ExplorationRun|null):{durationMs:number|null;requests:number;knownTokens:number|null;usageComplete:boolean;callCount:number};
