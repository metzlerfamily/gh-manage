import { LEVELS } from "../core/permissions";
import type { AppSpec } from "../core/schema";

export function Permissions({ spec }: { spec: AppSpec }) {
  const rows = LEVELS.flatMap((level) => Object.entries(spec.permissions[level] ?? {}).map(([perm, g]) => ({ level, perm, ...g })));
  return (
    <table className="perms">
      <thead>
        <tr>
          <th>Level</th>
          <th>Permission</th>
          <th>Access</th>
          <th>Justification</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.level}.${r.perm}`}>
            <td>{r.level}</td>
            <td>
              <code>{r.perm}</code>
            </td>
            <td>{r.access}</td>
            <td>{r.justification}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
