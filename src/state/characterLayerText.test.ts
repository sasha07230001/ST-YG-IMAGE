/* 冷启动:chatMetadata 迟到时角色层依然有词。
   这一条锁住用户报过两次的那个 bug —— 渠道页写着「0 个角色 / 进角色层（空）」,
   点一下「角色档案」页又好了。根因是内存缓存只读一次、而启动那次 chatMetadata 还是空的。 */
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

const RAW =
  "1girl, Long hair down to her waist, with a few strands of red and green dyed into her black hair, Pink, petite, giant boobs: 1.16, natural breasts: 0.89, pussy: 0.96, big butt: 0.73, There's a freckle-shaped birthmark on the left buttock";

const BOOK = {
  schemaVersion: 1,
  revision: 1,
  entries: [
    {
      name: '苏白粥',
      keywords: ['妈妈', '苏白粥', '白粥', '母亲'],
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
      raw: RAW,
      nl: '',
      desc: '',
      enabled: true,
    },
  ],
};

const CHAT = {
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
      raw: RAW,
      nl: '',
      matched: ['苏白粥'],
      floor: 6,
      at: 1,
      by: 'seed',
      history: [],
    },
  ],
};

describe('冷启动:chatMetadata 迟到时角色层依然有词', () => {
  beforeEach(() => {
    vi.resetModules();
    ctx = {
      // 档案库位置与线上一致:挂在 extension_settings 顶层(不是 baibai_image 里面)
      extensionSettings: { baibai_image_char_profile_book: BOOK },
      // 关键:插件启动那一刻 ST 还没把聊天数据交上来
      chatMetadata: {},
      chat: [{ mes: '苏白粥推开门。' }],
      saveSettingsDebounced: () => {},
      saveMetadataDebounced: () => {},
    };
  });

  it('启动时 chatMetadata 为空,之后补上:不用重开面板,列表与成品串就有词', async () => {
    const profiles = await import('@/state/charProfiles');
    const store = await import('@/state/characterPromptStore');

    profiles.initProfileBook();
    profiles.hydrateChatProfiles();
    // 启动那次读到的是空的 —— 这正是「渠道页 0 个角色」的那一刻
    expect(store.listCharacterPromptRows()).toEqual([]);

    // ST 稍后把聊天数据交上来
    ctx.chatMetadata = { yg_char_profiles: CHAT };

    // 不做任何别的动作,直接问角色层
    const rows = store.listCharacterPromptRows();
    expect(rows.map(row => row.name)).toEqual(['苏白粥']);
    // 「进角色层」必须就是档案那串词 —— 用户抱怨的正是这里写着（空）
    expect(rows[0].effective).toBe(RAW);
    expect(store.characterLayerText()).toBe(RAW);
  });

  it('关键词命中播种后,那一行立刻有词', async () => {
    const profiles = await import('@/state/charProfiles');
    const store = await import('@/state/characterPromptStore');

    profiles.initProfileBook();
    ctx.chatMetadata = { yg_char_profiles: { schemaVersion: 1, entries: [] } };
    profiles.hydrateChatProfiles();

    expect(profiles.seedChatProfilesFromText('苏白粥推开门。', 6)).toEqual(['苏白粥']);
    expect(store.characterLayerText()).toBe(RAW);
  });
});
