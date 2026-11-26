/** main의 실제 보호 규칙과 우회 불가 응답. 통신 순서를 직접 제어하는 시험에서도 쓴다. */
export const protectedMainRules = [
  { type: 'pull_request', ruleset_id: 1, parameters: { require_code_owner_review: true } },
  { type: 'required_status_checks', ruleset_id: 1, parameters: {
    strict_required_status_checks_policy: true, required_status_checks: [{ context: 'agentwbs/int' }],
  } },
  { type: 'non_fast_forward', ruleset_id: 1 },
  { type: 'deletion', ruleset_id: 1 },
];

export function protectedMainResponse(path: string): Response | undefined {
  if (path.endsWith('/rules/branches/main')) return Response.json(protectedMainRules);
  if (path.endsWith('/rulesets/1')) return Response.json({ enforcement: 'active', current_user_can_bypass: 'never' });
  return undefined;
}
