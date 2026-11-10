/* 「此刻状态」:AI 每楼按剧情改写本聊天角色档案的 state,角色层立刻带上它。
   这条链是用户明确要求的能力 —— 换衣服/身体变化要自动进下一次拼接,
   任何一环断掉(协议不认、写不进、拼不出)都会让图停留在旧衣服上。 */
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

describe('本聊天角色档案:此刻状态由 AI 每楼更新', () => {
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

  it('field:"state" 写进档案,并立刻出现在角色层成品串里', async () => {
    const profiles = await import('@/state/charProfiles');
    profiles.initProfileBook();
    profiles.hydrateChatProfiles();
    profiles.seedChatProfilesFromText('苏白粥推开门。', 1);

    // 初始没有状态:角色层只有固定外貌
    expect(profiles.composeProfilesForPresent(['苏白粥'])).toBe('1girl, long black hair, red eyes');

    const result = profiles.applyProfileUpdates(
      [
        {
          name: '苏白粥',
          field: 'state',
          value: 'black lace dress, off shoulder, bare legs',
          nl: '',
          reason: '第 2 段换上晚礼服',
        },
      ],
      2,
    );
    expect(result.updated).toEqual(['苏白粥']);
    expect(profiles.findChatProfile('苏白粥')?.state).toBe('black lace dress, off shoulder, bare legs');

    // 拼接层拿到的是「外貌 + 此刻」,不是旧衣服
    const text = profiles.composeProfilesForPresent(['苏白粥']);
    expect(text).toContain('long black hair');
    expect(text).toContain('black lace dress');

    // 交给 AI 的区块也要带着这一格,否则下一楼它看不见、又会凭空写一套
    const block = profiles.buildChatProfileBlock(profiles.chatProfiles.entries, ['苏白粥']);
    expect(block).toContain('black lace dress');
    expect(block).toContain('此刻');
  });

  it('新建档时可以顺手带上初始状态', async () => {
    const profiles = await import('@/state/charProfiles');
    profiles.initProfileBook();
    profiles.hydrateChatProfiles();

    profiles.applyProfileUpdates(
      [
        {
          name: '林晚',
          field: 'new',
          value: '1girl, short black hair, green eyes',
          nl: '',
          state: 'white shirt, grey skirt',
          reason: '首次出场',
        },
      ],
      3,
    );
    const entry = profiles.findChatProfile('林晚');
    expect(entry?.state).toBe('white shirt, grey skirt');
    expect(profiles.composeProfilesForPresent(['林晚'])).toContain('white shirt');
  });

  it('状态可以清空', async () => {
    const profiles = await import('@/state/charProfiles');
    profiles.initProfileBook();
    profiles.hydrateChatProfiles();
    profiles.seedChatProfilesFromText('苏白粥推开门。', 1);
    profiles.applyProfileUpdates(
      [{ name: '苏白粥', field: 'state', value: 'towel, wet hair', nl: '', reason: '刚洗完澡' }],
      2,
    );
    expect(profiles.composeProfilesForPresent(['苏白粥'])).toContain('towel');

    profiles.updateChatProfile('苏白粥', { state: '' }, 3, '穿回衣服');
    expect(profiles.findChatProfile('苏白粥')?.state).toBe('');
    expect(profiles.composeProfilesForPresent(['苏白粥'])).toBe('1girl, long black hair, red eyes');
  });
});
