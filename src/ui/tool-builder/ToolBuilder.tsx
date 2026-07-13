import type { ToolApiClient } from '../api/tool-api';
import { FlowCanvas } from './FlowCanvas';
import { MetadataBar } from './MetadataBar';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import { PreviewPanel } from './PreviewPanel';
import { useDraftPreview } from './use-draft-preview';
import { AgentToolContextPanel } from './AgentToolContextPanel';

export function ToolBuilder({ client }: { readonly client: ToolApiClient }) {
  useDraftPreview(client);
  return <div className="tool-builder">
    <MetadataBar client={client} />
    <div className="builder-workspace"><NodePalette client={client} /><FlowCanvas /><NodeInspector client={client} /></div>
    <div className="result-workspace"><PreviewPanel /><AgentToolContextPanel /></div>
  </div>;
}
