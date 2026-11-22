const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 生成按时间字典序递增的紧凑唯一 ID（类 ULID），纯离线零外部依赖
 */
export function createId(prefix?: string): string {
  let now = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[now % 32] + timePart;
    now = Math.floor(now / 32);
  }

  let randPart = '';
  for (let i = 0; i < 12; i++) {
    randPart += CROCKFORD[Math.floor(Math.random() * 32)];
  }

  return prefix ? `${prefix}_${timePart}${randPart}` : `${timePart}${randPart}`;
}
