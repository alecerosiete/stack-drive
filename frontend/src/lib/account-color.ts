/**
 * Cada cuenta vinculada es una "capa" con color propio.
 *
 * Con 8 colores, un simple hash del id colisiona en cuanto hay 3-4 cuentas.
 * Por eso se asignan sobre el conjunto completo: cada cuenta (por orden de
 * vinculación) se queda con su color "preferido" por hash si está libre, o
 * con el siguiente libre. Es determinista y estable mientras no cambie el
 * conjunto de cuentas, y nunca repite color hasta superar las 8.
 */
const LAYER_COLORS = ['#ff7a3d', '#3fb8a6', '#e8c547', '#7c8cf8', '#e25d8a', '#8bc34a', '#4fa3e0', '#c77dff'];

const assigned = new Map<string, string>();

function hash(value: string): number {
  // FNV-1a: mejor dispersión que un hash polinómico para ids casi iguales.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function assignAccountColors(accounts: Array<{ id: string; linkedAt: string }>): void {
  assigned.clear();
  const used = new Set<number>();
  const ordered = [...accounts].sort((a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.id.localeCompare(b.id));
  for (const account of ordered) {
    let slot = hash(account.id) % LAYER_COLORS.length;
    if (used.size < LAYER_COLORS.length) {
      while (used.has(slot)) slot = (slot + 1) % LAYER_COLORS.length;
    }
    used.add(slot);
    assigned.set(account.id, LAYER_COLORS[slot]!);
  }
}

export function accountColor(accountId: string): string {
  return assigned.get(accountId) ?? LAYER_COLORS[hash(accountId) % LAYER_COLORS.length]!;
}

export function accountLabel(account: { alias: string | null; email: string }): string {
  return account.alias?.trim() || account.email;
}
