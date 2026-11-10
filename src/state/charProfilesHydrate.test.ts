/* 锁住「内容没变就不动引用」这条不变量。
   为什么值得单独一条:hydrate 每次新建数组引用 → 渠道页 computed 失效重算 →
   重算里又调 ensureChatProfiles → 无限重渲染,面板一打开就卡死(2026-11-10 实况)。
   这条用例只要变红,就说明有人把这个幂等优化又改回去了。 */
import { describe, expect, it, vi } from 'vitest';

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<{ mes: string }>;
  saveSettingsDebounced: () => void;
  saveMetadataDebounced: () => void;
}

let ctx: FakeCtx;

vi.mock('@/st/context', () => ({
  getContext: () => ctx,
}));

const one = {
  schemaVersion: 1,
  entries: [
    {
      name: '苏白粥',
      from: '苏白粥',
      fields: {
        fandom: '',
        sex: '',
        hair: '',
        eyes: '',
        skin: '',
        body: '',
        extra: '',
        outfit: '',
      },
      raw: '1girl, long silver hair, pink eyes',
      nl: '',
      matched: ['苏白粥'],
      floor: 6,
      at: 1,
      by: 'seed',
      history: [],
    },
  ],
};

describe('hydrate 幂等:内容没变就不换数组引用', () => {
  it('反复 ensure 不会让 computed 反复失效', async () => {
    vi.resetModules();
    ctx = {
      extensionSettings: {},
      chatMetadata: { yg_char_profiles: one },
      chat: [{ mes: '苏白粥推开门。' }],
      saveSettingsDebounced: () => {},
      saveMetadataDebounced: () => {},
    };
    const mod = await import('@/state/charProfiles');
    mod.hydrateChatProfiles();
    const first = mod.chatProfiles.entries;
    mod.ensureChatProfiles();
    mod.ensureChatProfiles();
    mod.ensureChatProfiles();
    // 同一个引用 —— 渲染层不会因为「重读」而反复重算
    expect(mod.chatProfiles.entries).toBe(first);
  });

  it('磁盘内容真的变了才换引用', async () => {
    vi.resetModules();
    ctx = {
      extensionSettings: {},
      chatMetadata: { yg_char_profiles: one },
      chat: [{ mes: '苏白粥推开门。' }],
      saveSettingsDebounced: () => {},
      saveMetadataDebounced: () => {},
    };
    const mod = await import('@/state/charProfiles');
    mod.hydrateChatProfiles();
    const first = mod.chatProfiles.entries;
    expect(first.map(entry => entry.name)).toEqual(['苏白粥']);

    // 另一个标签页 / 手改文件后 ST 重新载入 metadata
    ctx.chatMetadata = {
      yg_char_profiles: {
        schemaVersion: 1,
        entries: [
          { ...one.entries[0], name: '苏白粥' },
          {
            name: '林晚',
            from: '林晚',
            fields: {
              fandom: '',
              sex: '',
              hair: 'long black hair',
              eyes: 'red eyes',
              skin: '',
              body: '',
              extra: '',
              outfit: '',
            },
            raw: '',
            nl: '',
            matched: ['林晚'],
            floor: 9,
            at: 2,
            by: 'manual',
            history: [],
          },
        ],
      },
    };
    mod.ensureChatProfiles();
    expect(mod.chatProfiles.entries).not.toBe(first);
    expect(mod.chatProfiles.entries.map(entry => entry.name)).toEqual(['苏白粥', '林晚']);
  });
});
