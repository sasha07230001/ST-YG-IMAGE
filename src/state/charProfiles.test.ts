import { settings } from '@/state/settings';
import { hydrateSettings } from '@/state/settings';
import {
  applyProfileUpdates,
  buildChatProfileBlock,
  chatProfileTag,
  chatProfiles,
  dropChatProfile,
  emptyProfileFields,
  findChatProfile,
  findProfile,
  hydrateChatProfiles,
  initProfileBook,
  listProfileBook,
  matchProfileKeywords,
  normalizeKeywords,
  profileBook,
  profileEntryTag,
  removeProfile,
  reseedChatProfile,
  rollbackChatProfile,
  seedChatProfile,
  seedChatProfilesFromText,
  updateChatProfile,
  upsertProfile,
  composeProfilesForPresent,
  resolvePresentProfiles,
  type ChatProfile,
  type ChatProfileChange,
  type ProfileEntry,
  type ProfileFields,
  type ProfileUpdate,
} from '@/state/charProfiles';
import { CHAR_TAG_FIELDS } from '@/state/charTags';
import { getContext } from '@/st/context';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 角色档案两层结构的行为锁。
 *
 * 这里只锁**纯逻辑**:关键词命中、播种、AI 写回、在场判定、库里不动。
 * 存储层(extensionSettings / chatMetadata)用一个假的 getContext 顶掉,
 * 断言的是「写进哪一层」,而不是 ST 的落盘细节。
 */

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

function makeCtx(): FakeCtx {
  return {
    extensionSettings: {},
    chatMetadata: {},
    chat: [],
    saveSettingsDebounced: () => {},
    saveMetadataDebounced: () => {},
  };
}

function profile(name: string, overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    name,
    keywords: [name],
    fields: { ...emptyProfileFields(), sex: '1girl', hair: 'long silver hair', eyes: 'red eyes' },
    raw: '',
    nl: '',
    desc: '',
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  ctx = makeCtx();
  initProfileBook();
  profileBook.entries = [];
  hydrateChatProfiles();
  chatProfiles.entries = [];
  void hydrateSettings;
  void settings;
});

/**
 * 内存里的本聊天档案是 chatMetadata 的**缓存**,而 `ensureChatProfiles()` 每次都会重读
 * (启动时 chatMetadata 可能还没到,只读一次就会把空数组锁进缓存)。测试里直接改
 * `chatProfiles.entries` 等于改缓存,下一次重读就被磁盘那份覆盖 —— 所以统一走
 * 这个函数:先写 chatMetadata,再让缓存重读,两步都做才对得上真实运行顺序。
 */
function seedChatProfiles(entries: ChatProfile[]): void {
  const ctxNow = ctx as unknown as { chatMetadata: Record<string, unknown> };
  ctxNow.chatMetadata.yg_char_profiles = {
    schemaVersion: 1,
    entries: JSON.parse(JSON.stringify(entries)) as ChatProfile[],
  };
  hydrateChatProfiles();
}

describe('档案库:只读给 AI,用户手动维护', () => {
  it('写入档案库落在 extensionSettings,不动本聊天档案', () => {
    upsertProfile(profile('小雪', { keywords: ['小雪', '雪'] }));
    expect(profileBook.entries).toHaveLength(1);
    expect(chatProfiles.entries).toHaveLength(0);
    const host = ctx.extensionSettings.baibai_image as Record<string, unknown>;
    const store = host.baibai_image_char_profile_book as { entries: ProfileEntry[] };
    expect(store.entries[0].name).toBe('小雪');
    expect(store.entries[0].keywords).toEqual(['小雪', '雪']);
  });

  it('没填关键词时用角色名兜底', () => {
    upsertProfile(profile('阿黛尔', { keywords: [] }));
    expect(profileBook.entries[0].keywords).toEqual(['阿黛尔']);
  });

  it('关键词去重、去空白、丢掉过长项', () => {
    expect(normalizeKeywords([' 雪 ', '雪', '', 'x'.repeat(40), '小雪'])).toEqual(['雪', '小雪']);
  });

  it('同名角色只留一条(大小写不敏感)', () => {
    upsertProfile(profile('Rin'));
    upsertProfile(profile('rin', { keywords: ['rin'] }));
    expect(profileBook.entries).toHaveLength(1);
    expect(profileBook.entries[0].keywords).toEqual(['rin']);
  });

  it('删除档案库条目不影响已经播种出来的本聊天档案', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪推开门。', 1);
    expect(chatProfiles.entries).toHaveLength(1);
    removeProfile('小雪');
    expect(profileBook.entries).toHaveLength(0);
    expect(chatProfiles.entries[0].fields.hair).toBe('long silver hair');
  });
});

describe('关键词命中 → 建本聊天档案', () => {
  it('关键词出现即播种,且只播种一次', () => {
    upsertProfile(profile('小雪', { keywords: ['小雪', '雪乃'] }));
    expect(seedChatProfilesFromText('她喊了一声雪乃。', 3)).toEqual(['小雪']);
    expect(chatProfiles.entries).toHaveLength(1);
    expect(chatProfiles.entries[0].floor).toBe(3);
    expect(chatProfiles.entries[0].matched).toEqual(['雪乃']);
    expect(seedChatProfilesFromText('雪乃又喊了一次。', 5)).toEqual([]);
    expect(chatProfiles.entries).toHaveLength(1);
  });

  it('没命中关键词就不建(名字出现在别处也不算)', () => {
    upsertProfile(profile('小雪', { keywords: ['雪乃'] }));
    expect(seedChatProfilesFromText('小雪推开门。', 1)).toEqual([]);
    expect(chatProfiles.entries).toHaveLength(0);
  });

  it('英文关键词按词边界匹配,不会被长词吃掉', () => {
    upsertProfile(profile('Rin', { keywords: ['rin'] }));
    expect(seedChatProfilesFromText('she was grinning at me', 1)).toEqual([]);
    expect(seedChatProfilesFromText('Rin waved.', 2)).toEqual(['Rin']);
  });

  it('停用的档案库条目不会被播种', () => {
    upsertProfile(profile('小雪', { enabled: false }));
    expect(seedChatProfilesFromText('小雪走进来。', 1)).toEqual([]);
  });

  it('matchProfileKeywords 可以排除已有档案的角色', () => {
    upsertProfile(profile('小雪'));
    upsertProfile(profile('阿黛尔'));
    const hits = matchProfileKeywords('小雪和阿黛尔都到了', { exclude: ['小雪'] });
    expect(hits.map(hit => hit.entry.name)).toEqual(['阿黛尔']);
  });
});

describe('本聊天档案:AI 按剧情更新', () => {
  it('AI 建档落在 chatMetadata,档案库那份不动', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    applyProfileUpdates(
      [{ name: '小雪', field: 'hair', value: 'short red hair', nl: '', reason: '染发并剪短' }],
      4,
    );
    expect(findChatProfile('小雪')?.fields.hair).toBe('short red hair');
    expect(findProfile('小雪')?.fields.hair).toBe('long silver hair');
  });

  it('field:"new" 对已有档案只补空缺,不推翻已变化的值', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    applyProfileUpdates([{ name: '小雪', field: 'eyes', value: 'gold eyes', nl: '', reason: '' }], 2);
    applyProfileUpdates(
      [
        {
          name: '小雪',
          field: 'new',
          value: '1girl, long silver hair, red eyes',
          nl: '',
          reason: '首次出场',
        },
      ],
      3,
    );
    const chat = findChatProfile('小雪');
    expect(chat?.fields.eyes).toBe('gold eyes');
    expect(chat?.fields.hair).toBe('long silver hair');
  });

  it('AI 报了新角色的整串就直接建档', () => {
    const result = applyProfileUpdates(
      [{ name: '冬海', field: 'new', value: '1girl, long black hair, blue eyes', nl: '', reason: '首次出场' }],
      7,
    );
    expect(result.created).toEqual(['冬海']);
    expect(findChatProfile('冬海')?.raw).toBe('1girl, long black hair, blue eyes');
    expect(findChatProfile('冬海')?.by).toBe('ai');
  });

  it('对没有档案的角色报字段变化会先建再写', () => {
    applyProfileUpdates([{ name: '路人', field: 'hair', value: 'short black hair', nl: '', reason: '' }], 2);
    expect(findChatProfile('路人')?.fields.hair).toBe('short black hair');
  });

  it('值没变时计为 unchanged 且不写历史', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    const before = findChatProfile('小雪')!.history.length;
    const result = applyProfileUpdates(
      [{ name: '小雪', field: 'hair', value: 'long silver hair', nl: '', reason: '' }],
      2,
    );
    expect(result.unchanged).toBe(1);
    expect(findChatProfile('小雪')!.history.length).toBe(before);
  });

  it('手动编辑与回滚都写进历史', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    updateChatProfile('小雪', { fields: { hair: 'long blue hair' } }, -1, '手动编辑');
    const record = findChatProfile('小雪')!.history.at(-1) as ChatProfileChange;
    expect(record.field).toBe('hair');
    expect(record.from).toBe('long silver hair');
    rollbackChatProfile('小雪', record);
    expect(findChatProfile('小雪')?.fields.hair).toBe('long silver hair');
  });

  it('从档案库重新播种会覆盖 AI 的改动但保留历史', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    const historyBefore = findChatProfile('小雪')!.history.length;
    updateChatProfile('小雪', { fields: { hair: 'short black hair' } }, -1, '手动编辑');
    expect(reseedChatProfile('小雪', 5)).toBe(true);
    const chat = findChatProfile('小雪')!;
    expect(chat.fields.hair).toBe('long silver hair');
    expect(chat.history.length).toBeGreaterThan(historyBefore);
  });

  it('作废本聊天档案后,正文再提关键词会重新播种', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    expect(dropChatProfile('小雪')).toBe(true);
    expect(chatProfiles.entries).toHaveLength(0);
    expect(seedChatProfilesFromText('小雪又出现了。', 9)).toEqual(['小雪']);
  });
});

describe('角色层取词', () => {
  it('AI 写出的 tag 里出现名字就算在场', () => {
    upsertProfile(profile('小雪'));
    upsertProfile(profile('阿黛尔'));
    seedChatProfilesFromText('小雪和阿黛尔都在。', 1);
    const present = resolvePresentProfiles({ prompt: '1girl, small booth, rain' });
    expect(present).toEqual([]);
    const hit = resolvePresentProfiles({ prompt: '1girl, 小雪 sitting on a school desk' });
    expect(hit).toEqual(['小雪']);
  });

  it('本楼正文命中关键词也算在场(别人只被提到一句)', () => {
    upsertProfile(profile('小雪', { keywords: ['小雪', '雪'] }));
    seedChatProfilesFromText('雪站在门口。', 1);
    const present = resolvePresentProfiles({ prompt: '1girl, standing', story: '雪站在门口。' });
    expect(present).toEqual(['小雪']);
  });

  it('上一楼在场的继续保留', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    expect(resolvePresentProfiles({ prompt: '1girl, standing', previous: ['小雪'] })).toEqual(['小雪']);
  });

  it('没有档案库条目的名字不会凭空出现', () => {
    expect(resolvePresentProfiles({ prompt: '1girl, 路人甲', story: '路人甲' })).toEqual([]);
  });

  it('角色层的成品串按在场者合成', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    expect(composeProfilesForPresent(['小雪'])).toBe('1girl, long silver hair, red eyes');
    expect(composeProfilesForPresent([])).toBe('');
    expect(composeProfilesForPresent(['别人'])).toBe('');
  });

  it('空档案不产生整串', () => {
    const empty: ChatProfile = {
      name: '空',
      from: '',
      fields: emptyProfileFields(),
      raw: '',
      nl: '',
      state: '',
      mine: '',
      matched: [],
      floor: 0,
      at: 0,
      by: 'seed',
      history: [],
    };
    expect(chatProfileTag(empty)).toBe('');
    expect(profileEntryTag({ fields: emptyProfileFields(), raw: '' })).toBe('');
  });
});

describe('给 AI 的档案区块', () => {
  it('列出本聊天档案并标出本次命中的', () => {
    upsertProfile(profile('小雪'));
    upsertProfile(profile('阿黛尔', { fields: { ...emptyProfileFields(), hair: 'long black hair' } }));
    seedChatProfilesFromText('小雪和阿黛尔都到了。', 1);
    const block = buildChatProfileBlock(chatProfiles.entries, ['小雪']);
    expect(block).toContain('【本聊天角色档案】');
    expect(block).toContain('- 小雪[本次命中]: 1girl, long silver hair, red eyes');
    expect(block).toContain('- 阿黛尔[本聊天已有]: long black hair');
  });

  it('没有档案时返回空串(不占消息位)', () => {
    expect(buildChatProfileBlock([], [])).toBe('');
  });
});

describe('PROFILE_UPDATES 协议形状', () => {
  it('applyProfileUpdates 忽略空值字段', () => {
    upsertProfile(profile('小雪'));
    seedChatProfilesFromText('小雪出现。', 1);
    const updates: ProfileUpdate[] = [{ name: '小雪', field: 'hair', value: '   ', nl: '', reason: '' }];
    const result = applyProfileUpdates(updates, 2);
    expect(result.unchanged + result.updated.length + result.created.length).toBe(0);
  });

  it('字段与 CHAR_TAG_FIELDS 保持同一份', () => {
    const fields: ProfileFields = emptyProfileFields();
    expect(Object.keys(fields)).toEqual([...CHAR_TAG_FIELDS]);
  });
});

describe('档案库兜底:本聊天没播种也能取到初始外貌', () => {
  it('listProfileBook 返回副本,改它不影响档案库', () => {
    upsertProfile(profile('苏白粥', { keywords: ['苏白粥', '白粥'] }));
    const snapshot = listProfileBook();
    snapshot[0].name = '被改了';
    snapshot[0].fields.hair = 'green hair';
    expect(findProfile('苏白粥')?.name).toBe('苏白粥');
    expect(findProfile('苏白粥')?.fields.hair).toBe('long silver hair');
    expect(listProfileBook()).toHaveLength(1);
  });

  it('档案库有词但本聊天还没播种:在场判定为空,档案库那份不被复制过去', () => {
    upsertProfile(profile('苏白粥', { keywords: ['苏白粥', '白粥'] }));
    expect(resolvePresentProfiles({ story: '白粥把碗放回桌上。' })).toEqual([]);
    expect(chatProfiles.entries).toHaveLength(0);
  });

  it('播种之后,在场判定按档案库关键词命中', () => {
    upsertProfile(profile('苏白粥', { keywords: ['苏白粥', '白粥'] }));
    seedChatProfilesFromText('白粥停下了脚步。', 3);
    expect(resolvePresentProfiles({ story: '白粥把碗放回桌上。' })).toEqual(['苏白粥']);
  });

  it('本聊天档案存在但整串为空时给不出词,调用方该回退档案库', () => {
    upsertProfile(profile('苏白粥'));
    seedChatProfile(profile('苏白粥'), ['苏白粥'], 2);
    updateChatProfile(
      '苏白粥',
      { fields: { ...emptyProfileFields() }, raw: '' },
      2,
      '手动清空',
    );
    expect(profileEntryTag(chatProfiles.entries[0])).toBe('');
    expect(composeProfilesForPresent(['苏白粥'])).toBe('');
    expect(profileEntryTag(findProfile('苏白粥')!)).toContain('silver hair');
  });
});
