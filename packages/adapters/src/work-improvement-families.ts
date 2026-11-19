import type { WorkImprovementCase, WorkImprovementInput } from "./work-improvement.js";
import { FILE_DELIVERY_PILOT, fileDeliveryPilotCases } from "./work-improvement-pilot-cases.js";
import { RELEASE_CHECK_PILOT, releaseCheckPilotCases } from "./work-improvement-release-cases.js";
import { RESEARCH_CHECK_PILOT, researchCheckPilotCases } from "./work-improvement-research-cases.js";

/** One class of work a taught skill can be enrolled in and measured against. */
export interface WorkImprovementFamily {
  id: string;
  caseSet: { id: string; revision: string };
  outputContract: WorkImprovementInput["outputContract"];
  cases(project: string): WorkImprovementCase[];
}

export const WORK_IMPROVEMENT_FAMILIES: readonly WorkImprovementFamily[] = [
  {
    id: FILE_DELIVERY_PILOT.id,
    caseSet: { id: FILE_DELIVERY_PILOT.id, revision: FILE_DELIVERY_PILOT.revision },
    outputContract: FILE_DELIVERY_PILOT.outputContract,
    cases: fileDeliveryPilotCases,
  },
  {
    id: RELEASE_CHECK_PILOT.id,
    caseSet: { id: RELEASE_CHECK_PILOT.id, revision: RELEASE_CHECK_PILOT.revision },
    outputContract: RELEASE_CHECK_PILOT.outputContract,
    cases: releaseCheckPilotCases,
  },
  {
    id: RESEARCH_CHECK_PILOT.id,
    caseSet: { id: RESEARCH_CHECK_PILOT.id, revision: RESEARCH_CHECK_PILOT.revision },
    outputContract: RESEARCH_CHECK_PILOT.outputContract,
    cases: researchCheckPilotCases,
  },
];

export function workImprovementFamily(id: string): WorkImprovementFamily | undefined {
  return WORK_IMPROVEMENT_FAMILIES.find((family) => family.id === id);
}
