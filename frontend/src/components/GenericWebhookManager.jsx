import Workflows from '../pages/Workflows';

// Generic CRM marketing embeds the existing workflow engine in a webhook-
// focused mode. The normal /workflows page keeps its default, unfiltered UI.
export default function GenericWebhookManager() {
  return <Workflows webhookOnly embedded />;
}

