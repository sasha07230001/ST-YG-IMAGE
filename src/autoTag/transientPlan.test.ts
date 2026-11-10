import { describe, expect, it } from 'vitest';
import { planTransientUpdates } from '@/autoTag/runner';

/**
 * 0.7 单次调用:穿戴(transient)与画面挤在同一份 JSON 里。
 * 这里锁住「谁说了算」—— 冻结条目 AI 连清空都不许,不存在的条目不写空键。
 */
describe('auto tag:穿戴更新换算', () => {
  it('改写已有条目 → 进 updates,保留原 prompt 文本', () => {
    const plan = planTransientUpdates(
      [{ name: '小雪', prompt: 'black lace dress, long sleeves', cleared: false }],
      [{ name: '小雪', frozen: false }],
    );
    expect(plan.updates).toEqual([{ name: '小雪', prompt: 'black lace dress, long sleeves' }]);
    expect(plan.clears).toEqual([]);
    expect(plan.frozen).toBe(0);
  });

  it('裸身(空串)= 清空已有条目,不给「沿用上次」留后路', () => {
    const plan = planTransientUpdates(
      [{ name: '小雪', prompt: '', cleared: true }],
      [{ name: '小雪' }],
    );
    expect(plan.clears).toEqual(['小雪']);
    expect(plan.updates).toEqual([]);
  });

  it('没有这条却说「清空」是空操作:不留空键', () => {
    const plan = planTransientUpdates(
      [{ name: '阿岚', prompt: '', cleared: true }],
      [],
    );
    expect(plan.clears).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it('冻结条目一律跳过,改写与清空都不生效', () => {
    const plan = planTransientUpdates(
      [
        { name: '小雪', prompt: 'red hoodie', cleared: false },
        { name: '阿岚', prompt: '', cleared: true },
      ],
      [
        { name: '小雪', frozen: true },
        { name: '阿岚', frozen: true },
      ],
    );
    expect(plan.updates).toEqual([]);
    expect(plan.clears).toEqual([]);
    expect(plan.frozen).toBe(2);
  });

  it('没建档的角色也能记穿戴:新条目直接新增', () => {
    const plan = planTransientUpdates(
      [{ name: '路人乙', prompt: 'grey coat', cleared: false }],
      [{ name: '小雪' }],
    );
    expect(plan.updates).toEqual([{ name: '路人乙', prompt: 'grey coat' }]);
    expect(plan.frozen).toBe(0);
  });
});
