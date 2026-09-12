import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { VERSION } from 'openai/version';
import { version } from '../../package.json';
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';
export type HarnessOutcome = {
  status: 'completed' | 'failed' | 'interrupted' | 'timed_out';
  error?: unknown;
  abort_reason?: unknown;
  export_error?: unknown;
  cleanup_errors?: unknown[];
};
// Error properties and SDK Headers are not preserved by JSON.stringify alone.
export function errorDetails(value: unknown): unknown {
  if (value instanceof Headers) return Object.fromEntries(value);
  if (Array.isArray(value)) return value.map(errorDetails);
  if (!(value instanceof Error)) return value;
  return {
    name: value.name,
    ...Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [
        key,
        errorDetails((value as unknown as Record<string, unknown>)[key]),
      ]),
    ),
  };
}
const parse = (value: string | null | undefined): unknown => {
  if (!value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const metrics = (response: OpenAIResponse) => ({
  prompt_tokens: response.usage?.input_tokens ?? 0,
  completion_tokens: response.usage?.output_tokens ?? 0,
  cached_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
});
const totalMetrics = (responses: OpenAIResponse[], steps = responses.length) => {
  const usage = responses.map(metrics);
  const sum = (key: keyof ReturnType<typeof metrics>) =>
    usage.reduce((total, current) => total + current[key], 0);
  return {
    total_prompt_tokens: sum('prompt_tokens'),
    total_completion_tokens: sum('completion_tokens'),
    total_cached_tokens: sum('cached_tokens'),
    total_steps: steps,
  };
};
const reasoning = (response: OpenAIResponse) =>
  response.output
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => item.summary)
    .map((item) => item.text)
    .join('\n');
export function buildAtif(input: {
  trialId: string;
  sessionName: string;
  simulationId: string | null;
  model: string;
  reasoning: ReasoningLevel;
  prompt: string;
  seats: Array<{
    playerId: string;
    sessionId: string;
    responses: OpenAIResponse[];
    errors?: unknown[];
    mcpCalls?: unknown[];
  }>;
  result: unknown;
  harness: HarnessOutcome;
  operatorCalls?: unknown[];
  resumeEvents?: unknown[];
}) {
  const run = {
    provider: 'openai-responses',
    model: input.model,
    harbor_version: process.env.HARBOR_VERSION ?? null,
    sdk_version: VERSION,
  };
  const seats = input.seats.map((seat, seatIndex) => {
    const generated = seat.responses.map((response, index) => {
      const calls = response.output.filter((item) => item.type === 'mcp_call');
      return {
        step_id: index + 1,
        source: 'agent',
        model_name: response.model,
        message:
          response.output_text ||
          response.output
            .filter((item) => item.type === 'message')
            .flatMap((item) => item.content)
            .map((item) => (item.type === 'output_text' ? item.text : item.refusal))
            .join('\n'),
        reasoning_content: reasoning(response),
        tool_calls: calls.map((call) => {
          const args = parse(call.arguments);
          return {
            tool_call_id: call.id,
            function_name: call.name,
            arguments:
              args && typeof args === 'object' && !Array.isArray(args)
                ? args
                : { raw_arguments: call.arguments },
          };
        }),
        observation: {
          results: calls.map((call) => ({
            source_call_id: call.id,
            content: call.output ?? JSON.stringify(call.error) ?? '',
          })),
        },
        metrics: metrics(response),
        llm_call_count: 1,
        extra: {
          response,
          request_id: (response as OpenAIResponse & { _request_id?: string | null })._request_id,
        },
      };
    });
    return {
      schema_version: 'ATIF-v1.7',
      session_id: seat.sessionId,
      trajectory_id: `${input.trialId}-seat-${seatIndex + 1}`,
      agent: {
        name: 'PokerBeerBench OpenAI Responses player',
        version,
        extra: { ...run, player_id: seat.playerId },
      },
      steps: generated,
      final_metrics: totalMetrics(seat.responses),
      extra: { errors: seat.errors ?? [], mcp_calls: seat.mcpCalls ?? [] },
    };
  });
  const children = seats.filter((seat) => seat.steps.length);
  return {
    schema_version: 'ATIF-v1.7',
    session_id: input.sessionName,
    trajectory_id: `${input.trialId}-root`,
    agent: {
      name: 'PokerBeerBench',
      version,
      extra: { ...run, reasoning: input.reasoning },
    },
    steps: [
      { step_id: 1, source: 'user', message: input.prompt },
      {
        step_id: 2,
        source: 'agent',
        message:
          input.harness.status === 'completed'
            ? 'All eight players completed the tournament.'
            : `Harness ${input.harness.status}; see the preserved evidence and canonical game result.`,
        llm_call_count: 0,
        observation: {
          results: children.map((child) => ({
            subagent_trajectory_ref: [
              { trajectory_id: child.trajectory_id, session_id: child.session_id },
            ],
          })),
        },
      },
    ],
    final_metrics: totalMetrics(
      input.seats.flatMap((seat) => seat.responses),
      2,
    ),
    extra: {
      simulation_id: input.simulationId,
      result: input.result,
      harness: input.harness,
      operator_calls: input.operatorCalls ?? [],
      resume_events: input.resumeEvents ?? [],
      seats_without_turns: seats.filter((seat) => !seat.steps.length),
    },
    subagent_trajectories: children,
  };
}
