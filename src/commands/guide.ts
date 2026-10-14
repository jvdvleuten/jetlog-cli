import guideText from "../../docs/AGENT_GUIDE.md";

/** The agent guide for this version, bundled into the build from docs/AGENT_GUIDE.md. */
export function agentGuide(): string {
  return guideText;
}

export function printGuide(): void {
  process.stdout.write(guideText.endsWith("\n") ? guideText : `${guideText}\n`);
}
