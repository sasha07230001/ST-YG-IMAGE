/* 「用户追加的提示词」:整份本聊天档案由 AI 按剧情更新,但用户要能随时塞一句自己的话,
   而且那句不能被 AI 覆盖、也不该让 AI 停止更新别的格子。
   这一格(mine)是用户意志唯一的落点 —— 写进 fields 会被 AI 当成可补全字段,
   写进 state 下一楼就被穿戴记录顶掉。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const BOOK = {
  schemaVersion: 1,
  revision: 1,
  entries: [
    {
      name: '苏白粥',
      keywords: ['苏白粥'],
      fields: {
        fandom: '',
        sex: '1girl',
        hair: 'long black hair',
        eyes: 'red eyes',
        skin: '',
        body: '',
        extra: '',
        outfit: '',
      },
      raw: '',
      nl: '',
      desc: '',
      enabled: true,
    },
  ],
};

describe('本聊天角色档案:用户追加的提示词与 AI 更新互不干扰', () => {
  beforeEach(() => {
    vi.resetModules();
    ctx = {
      extensionSettings: { baibai_image_char_profile_book: BOOK },
      chatMetadata: { yg_char_profiles: { schemaVersion: 1, entries: [] } },
      chat: [{ mes: '苏白粥推开门。' }],
      saveSettingsDebounced: () => {},
      saveMetadataDebounced: () => {},
    };
  });

  it('用户追加的词会进角色层,并且 AI 覆盖不了它', async () => {
    const profiles = await import('@/state/charProfiles');
    profiles.initProfileBook();
    profiles.hydrateChatProfiles();
    profiles.seedChatProfilesFromText('苏白粥推开门。', 1);

    profiles.updateChatProfile('苏白粥', { mine: 'always wearing a silver pendant' }, 2, '用户加的');

    const text = profiles.composeProfilesForPresent(['苏白粥']);
    expect(text).toContain('silver pendant');
    expect(text).toContain('long black hair');

    // AI 这一楼又改了外貌与穿戴:追加词必须还在
    profiles.applyProfileUpdates(
      [
        { name: '苏白粥', field: 'state', value: 'black lace dress, bare legs', nl: '', reason: '换装' },
        { name: '苏白粥', field: 'eyes', value: 'golden eyes', nl: '', reason: '瞳孔变色' },
      ],
      3,
    );

    const after = profiles.findChatProfile('苏白粥');
    expect(after?.mine).toBe('always wearing a silver pendant');
    expect(after?.state).toBe('black lace dress, bare legs');
    expect(after?.fields.eyes).toBe('golden eyes');
    const text2 = profiles.composeProfilesForPresent(['苏白粥']);
    expect(text2).toContain('silver pendant');
    expect(text2).toContain('black lace dress');
    expect(text2).toContain('golden eyes');
  });

  it('只改追加词不会把档案标记成「手动维护」', async () => {
    const profiles = await import('@/state/charProfiles');
    profiles.initProfileBook();
    profiles.hydrateChatProfiles();
    profiles.seedChatProfilesFromText('苏白粥推开门。', 1);
    expect(profiles.findChatProfile('苏白粥')?.by).toBe('seed');

    profiles.updateChatProfile('苏白粥', { mine: 'mole under left eye' }, 2, '用户加的');
    // 只动 mine:AI 的活照旧,不代表这份档案被人接手
    expect(profiles.findChatProfile('苏白粥')?.by).toBe('seed');

    // 改别的格子才算手动
    profiles.updateChatProfile('苏白粥', { raw: '1girl, short hair' }, 3, '用户改外貌');
    expect(profiles.findChatProfile('苏白粥')?.by).toBe('manual');
  });

  it('追加词清空后立刻失效,并且写进给 AI 的区块', async () => {
    const profiles = await import('@/state/charProfiles');
    profiles.initProfileBook();
    profiles.hydrateChatProfiles();
    profiles.seedChatProfilesFromText('苏白粥推开门。', 1);

    profiles.updateChatProfile('苏白粥', { mine: 'always holding an umbrella' }, 2, '用户加的');
    const block = profiles.buildChatProfileBlock(profiles.chatProfiles.entries, ['苏白粥']);
    expect(block).toContain('用户追加');
    expect(block).toContain('umbrella');

    profiles.updateChatProfile('苏白粥', { mine: '' }, 3, '用户删掉');
    expect(profiles.findChatProfile('苏白粥')?.mine).toBe('');
    expect(profiles.composeProfilesForPresent(['苏白粥'])).toBe('1girl, long black hair, red eyes');
  });
});
