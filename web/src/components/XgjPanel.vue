<script setup>
/**
 * ★ 闲管家对接设置面板 ★
 *
 * 五块内容：
 *   ① 自检：现在能不能对接、缺什么
 *   ② 要填到闲管家那边的信息（接口网关 + 商户ID + 对接密钥）—— 照着抄
 *   ③ 闲管家给我们的凭据（AppKey / AppSecret）
 *   ④ 售卖时长档位：增删档位，商品列表立刻跟着变
 *   ⑤ 商品预览：会生成哪些商品、各自还有多少货
 *
 * 说明一下为什么"商品预览"很重要：
 *   商品 = 游戏 × 档位，全是实时算出来的。没有预览的话，
 *   你在闲管家那边看到商品对不上，很难判断是我们算错了还是它配错了。
 */
import { ref, computed, onMounted } from 'vue';
import {
  state, refreshSettings, refreshXgj, refreshXgjLog, saveXgj, saveTiers, refresh,
} from '../lib/store.js';
import { copyText } from '../lib/api.js';
import { toastSuccess, toastError, toastWarn } from '../lib/toast.js';

const emit = defineEmits(['close']);

const busy = ref(false);
const tab = ref('setup');       // setup | goods
const newTier = ref('');        // 档位输入框（addTier 直接读它）

const cfg = computed(() => state.settings.xgj || {});
const status = computed(() => state.xgjStatus || {});
const goods = computed(() => state.xgjGoods || []);
const log = computed(() => state.xgjLog || { items: [], count: 0, hint: '' });

/** 闲管家调过我们几次 */
const calledCount = computed(() => log.value.count || 0);

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把请求路径翻译成人话 */
function whatIs(path) {
  const map = {
    '/goofish/open/info': '查询平台信息',
    '/goofish/user/info': '查询商户信息',
    '/goofish/goods/list': '查询商品列表',
    '/goofish/goods/detail': '查询商品详情',
    '/goofish/order/purchase/create': '创建卡密订单',
    '/goofish/order/detail': '查询订单详情',
  };
  return map[path] || path;
}

/**
 * 闲管家的「接口网关」要填什么。
 *
 * ★ 这里踩过坑 ★
 *   一开始直接用了 /api/settings 的 baseUrl，那是服务端按 HOST:PORT 拼的
 *   **本机地址**（http://127.0.0.1:8787）。面板上显示得像模像样，
 *   照着填进闲管家必然连不上 —— 因为闲管家的服务器访问不到你的 127.0.0.1。
 *
 * 取地址的优先级：
 *   ① state.publicBaseUrl —— 服务端记住的"最近一次从公网进来的地址"（隧道）
 *   ② location.origin     —— 你现在就是从这个地址打开页面的（那它就是对的）
 *   ③ 都没有 → 本机地址 + 明确警告，别让人拿去填
 */
const LOCAL_RE = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;

const gateway = computed(() => state.publicBaseUrl || location.origin);
/** 拿到的地址如果是本机的，闲管家根本访问不到，必须明说 */
const gatewayIsLocal = computed(() => LOCAL_RE.test(gateway.value));

onMounted(async () => {
  try { await refreshSettings(); } catch { /* 忽略 */ }
  try { await refreshXgj(); } catch { /* 忽略 */ }
});

async function patch(obj) {
  busy.value = true;
  try {
    await saveXgj(obj);
  } catch (e) {
    toastError('保存失败', { detail: e.message });
  } finally {
    busy.value = false;
  }
}

async function copy(text, label) {
  const ok = await copyText(String(text));
  if (ok) toastSuccess(`${label} 已复制`);
  else toastWarn('复制失败，请手动选中');
}

/** 生成一个随机的对接密钥 —— 闲管家要求"能保证签名不易破解即可" */
function randomSecret() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ---------------- 档位 ---------------- */
// ★ 只留一个 ref ★
//   之前这里同时有 `newTier`（v-model 绑的）和 `tierInput`（addTier 读的），
//   结果输入框填什么都会被忽略，加进去的永远是 tierInput 的初值「6 分钟」。
//   实测被测试抓到了。现在 addTier 读的就是输入框绑定的那个（顶部那个 newTier）。

/**
 * 「6」「360」「6小时」「3天」「6h」都认，统一换成分钟。
 *
 * ★ 单位必须按"最长匹配优先"判断 ★
 *   一开始只判了「小时」，结果填「3天」被当成 3 **分钟** ——
 *   界面看着没错、保存也成功，只是档位悄悄变成了 3 分钟，很难发现。
 */
function parseTier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/天|day/i.test(s)) return Math.round(n * 1440);
  if (/分钟|min/i.test(s)) return Math.round(n);
  if (/小时|hour|hr|h$/i.test(s)) return Math.round(n * 60);
  return Math.round(n);
}

async function addTier() {
  const m = parseTier(newTier.value);
  if (!m) { toastWarn('填个时长，例如 6小时 或 360'); return; }
  const cur = [...(state.settings.saleDurationTiers || [])];
  if (cur.includes(m)) { toastWarn('这个档位已经有了'); return; }
  cur.push(m);
  cur.sort((a, b) => a - b);
  busy.value = true;
  try { await saveTiers(cur); newTier.value = ''; toastSuccess(`已加档位：${fmtMin(m)}`); }
  catch (e) { toastError('保存失败', { detail: e.message }); }
  finally { busy.value = false; }
}

async function removeTier(m) {
  const cur = (state.settings.saleDurationTiers || []).filter((x) => x !== m);
  if (!cur.length) { toastWarn('至少要留一个档位'); return; }
  busy.value = true;
  try { await saveTiers(cur); toastSuccess(`已删档位：${fmtMin(m)}`); }
  catch (e) { toastError('保存失败', { detail: e.message }); }
  finally { busy.value = false; }
}

function fmtMin(m) {
  const n = Number(m) || 0;
  if (n < 60) return `${n} 分钟`;
  if (n % 1440 === 0) return `${n / 1440} 天`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return `${Math.floor(n / 60)} 小时 ${n % 60} 分钟`;
}

/**
 * ★ 给买家取码用的模板行 ★
 *
 * {$订单编号} 是**闲管家模板自己的变量语法**（不是 JS 模板串），
 * 所以这里必须用字符串拼接、不能写成 JS 的 ${...} —— 那会被当成变量插值。
 * 之前踩过这个坑：手写的变量语法和闲管家实际的语法不一样
 * （闲管家的是 {$卡密信息}，不是 ${卡密信息}），所以这一行要原样给出。
 */
function tplLine() {
  return [
    '取码地址：' + gateway.value + '/c/{$订单编号}',
    '',
    '登录 Steam 需要验证码时，点开上面的地址领取。',
    '（该地址只提供登录用的验证码，请勿用于其他操作）',
  ].join('\n');
}

/** 复制一段"给闲管家填"的完整信息 */
function fillSheet() {  return [
    '── 填到闲管家「货源授权信息」──',
    `接口网关：${gateway.value}`,
    `AppKey（对应 mch_id）：${cfg.value.mchId}`,
    `AppSecret（对应 mch_secret）：${cfg.value.mchSecret}`,
    '',
    '── 填到闲管家「应用概况」（它给你的，不用改）──',
    `AppKey（对应 app_id）：${cfg.value.appId || '（还没填）'}`,
    `AppSecret：${cfg.value.appSecret ? '（已填写）' : '（还没填）'}`,
  ].join('\n');
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet xgj pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">闲管家对接</div>
          <div class="sheet__sub">
            买家在闲鱼下单 → 闲管家调我们 → 自动发一个空闲账号的账号密码
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <!-- ① 自检 -->
        <div class="scard" :class="status.ready ? 'selfcheck--ok' : 'selfcheck--warn'">
          <div class="selfcheck">
            <div class="selfcheck__dot" :class="status.ready ? 'dot--ok' : 'dot--warn'" />
            <div class="selfcheck__body">
              <div class="selfcheck__t">
                {{ status.ready ? '✓ 可以对接了' : (status.enabled ? '还差几项配置' : '对接未开启') }}
              </div>
              <div class="selfcheck__d">
                <template v-if="status.ready">
                  把下面的「接口网关」和「商户密钥」填到闲管家后台，就能开始接单。
                </template>
                <template v-else-if="status.missing && status.missing.length">
                  还需要：
                  <span v-for="(m, i) in status.missing" :key="m" class="miss">
                    {{ m }}<template v-if="i < status.missing.length - 1">、</template>
                  </span>
                </template>
                <template v-else>打开下面的开关即可。</template>
              </div>
            </div>
          </div>
        </div>

        <!-- ★ 闲管家调我们的记录 ★
             排在最上面，因为"它到底调没调我们"是排查对接问题的第一现场：
             一条都没有 = 它那边的问题；有但 code 不对 = 我们这边的问题。 -->
        <div class="scard" :class="calledCount ? '' : 'logcard--empty'">
          <div class="card__head">
            <div>
              <div class="card__title">
                闲管家调我们的记录
                <span v-if="calledCount" class="lognum">{{ calledCount }} 次</span>
              </div>
              <div class="card__sub">
                你在闲管家那边点「关联商品 / 保存 / 下单」时，这里会立刻多出记录
              </div>
            </div>
            <button class="btn btn--sm" @click="refreshXgjLog()">刷新</button>
          </div>

          <div v-if="log.items && log.items.length" class="log">
            <div v-for="(e, i) in log.items" :key="i" class="logrow" :class="{ 'logrow--bad': e.code !== 0 }">
              <div class="logrow__main">
                <span class="logrow__t mono">{{ fmtTime(e.at) }}</span>
                <span class="logrow__what">{{ whatIs(e.path) }}</span>
                <span class="logrow__code" :class="e.code === 0 ? 'code--ok' : 'code--err'">
                  {{ e.code === 0 ? '✓ 成功' : `✗ code=${e.code}` }}
                </span>
                <span class="logrow__extra">
                  <template v-if="e.count !== null">返回 {{ e.count }} 个商品</template>
                  <template v-else-if="e.code !== 0">{{ e.msg }}</template>
                  <template v-else>{{ e.ms }}ms</template>
                </span>
              </div>
              <!-- ★ 它问了什么 ★ 排查"下拉是空的"时最关键的一行 -->
              <div v-if="e.body" class="logrow__body mono">问：{{ e.body }}</div>
              <!-- ★ 我们给了什么 ★ 确认两边说的是不是同一批东西 -->
              <div v-if="e.names && e.names.length" class="logrow__names">
                给：<span v-for="(n, j) in e.names" :key="j" class="namechip mono">{{ n }}</span>
              </div>
            </div>
          </div>
          <div v-else class="empty">
            <strong>一条记录都没有</strong> —— 说明闲管家<strong>压根没调到我们</strong>。<br>
            去它后台检查：① 「接口网关」填对了吗 ② 地址是不是已经失效（临时隧道重启就换）
            ③ 应用状态是不是「已上线」。
          </div>
        </div>

        <!-- ② 概览 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">当前会自动生成多少商品</div>
              <div class="card__sub">
                商品 = 游戏 × 售卖档位，<strong>都是实时算的</strong>。
                往账号库加一个新游戏的账号，商品就会自动多出来。
              </div>
            </div>
          </div>          <div class="stats">
            <div class="stat">
              <div class="stat__n">{{ status.games?.length ?? 0 }}</div>
              <div class="stat__k">游戏</div>
            </div>
            <div class="stat">
              <div class="stat__n">{{ state.settings.saleDurationTiers?.length ?? 0 }}</div>
              <div class="stat__k">档位</div>
            </div>
            <div class="stat">
              <div class="stat__n">{{ status.goodsCount ?? 0 }}</div>
              <div class="stat__k">商品</div>
            </div>
          </div>
          <div v-if="status.games?.length" class="gamelist">
            <span v-for="g in status.games" :key="g.game" class="chip">
              {{ g.game }} <em>{{ g.goods }}</em>
            </span>
          </div>
          <div v-else class="empty">
            账号库里还没有带「游戏名」的账号。先去添加几个账号，商品会自动出现。
          </div>
        </div>

        <!-- ③ 要填到闲管家那边 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">① 要把这些填到闲管家</div>
              <div class="card__sub">
                闲管家 → 开放平台 → 我的应用 → 添加应用 → 选「我有自研系统」→ 货源授权信息
              </div>
            </div>
            <button class="btn btn--sm" @click="copy(fillSheet(), '整段配置')">全部复制</button>
          </div>

          <div class="row">
            <div class="row__l">
              <div class="row__t">接口网关</div>
              <div class="row__d">闲管家的服务器要能访问到这个地址。必须是公网地址</div>
            </div>
            <div class="row__r">
              <code class="code mono" :class="{ 'code--bad': gatewayIsLocal }">{{ gateway }}</code>
              <button class="btn btn--sm" @click="copy(gateway, '接口网关')">复制</button>
            </div>
          </div>

          <!-- ★ 本机地址不能填 ★ 这里必须显眼，否则用户照抄必然对接失败 -->
          <div v-if="gatewayIsLocal" class="warnbox">
            <div class="warnbox__t">⚠️ 这个地址闲管家访问不到</div>
            <div class="warnbox__d">
              <code>{{ gateway }}</code> 是本机地址，只有你自己这台电脑能访问。<br>
              <strong>正确做法：</strong>双击项目里的
              <code>启动闲管家隧道.bat</code>，它会给你一个
              <code>https://xxx.trycloudflare.com</code> 的公网地址，
              <strong>用它从浏览器打开本页面</strong>，这里就会自动显示那个地址。
            </div>
          </div>

          <div class="row">
            <div class="row__l">
              <div class="row__t">商户 ID（对应 mch_id）</div>
              <div class="row__d">我们自己定的，随便起个名字</div>
            </div>
            <div class="row__r">
              <input
                class="input mono row__in"
                :value="cfg.mchId"
                placeholder="steam01"
                @change="patch({ mchId: $event.target.value })"
              />
            </div>
          </div>

          <div class="row">
            <div class="row__l">
              <div class="row__t">对接密钥（对应 mch_secret）</div>
              <div class="row__d">签名用的，越长越好。填错闲管家会一直报 401 签名错误</div>
            </div>
            <div class="row__r">
              <input
                class="input mono row__in"
                :value="cfg.mchSecret"
                placeholder="点右边「随机生成」"
                @change="patch({ mchSecret: $event.target.value })"
              />
              <button class="btn btn--sm" @click="patch({ mchSecret: randomSecret() })">随机生成</button>
              <button class="btn btn--sm" @click="copy(cfg.mchSecret, '对接密钥')">复制</button>
            </div>
          </div>
        </div>

        <!-- ★★★ 买家取码链接 ★★★
             用户特意交代过："要修改闲管家模板就修改吧，每次记得提醒我。"
             所以这块不只是一段文字 —— 它直接给出**可以整段复制**的模板行，
             而且地址跟着当前的公网地址走。隧道一换，这里就跟着变，
             用户打开面板就能看到该粘什么。 -->
        <div class="scard" :class="gatewayIsLocal ? 'logcard--empty' : ''">
          <div class="card__head">
            <div>
              <div class="card__title">
                买家取码链接
                <span class="lognum">模板要改</span>
              </div>
              <div class="card__sub">
                买家租了账号，登录 Steam 时要验证码，但码发到的是账号的邮箱（他拿不到）。
                把下面这行加进闲管家的<b>内容模板</b>，买家就能自己点开取码。
              </div>
            </div>
            <button class="btn btn--sm" @click="copy(tplLine(), '模板内容')">复制这行</button>
          </div>

          <div v-if="gatewayIsLocal" class="warnbox">
            <div class="warnbox__t">⚠️ 现在还没有公网地址</div>
            <div class="warnbox__d">
              取码链接必须是<b>公网地址</b>买家才打得开。<br>
              先双击 <code>启动闲管家隧道.bat</code>，拿到
              <code>https://xxx.trycloudflare.com</code>，再用那个地址打开本页面。
            </div>
          </div>

          <div class="row">
            <div class="row__l">
              <div class="row__t">粘进「内容模板」的这一行</div>
              <div class="row__d">
                闲管家 → 卡密仓库 → 发货 → 找到商品 → 修改设置 → 内容模板
              </div>
            </div>
          </div>
          <pre class="tplbox mono">{{ tplLine() }}</pre>

          <div class="warnbox warnbox--info">
            <div class="warnbox__t">🔁 隧道地址一变，这行就要重新粘一次</div>
            <div class="warnbox__d">
              <code>trycloudflare.com</code> 的地址<b>每次重启隧道都会换</b>。<br>
              所以每次重开隧道后，都回到这里点「复制这行」，再去闲管家把模板里的旧地址替换掉。<br>
              <span class="muted">（想彻底免掉这一步，就得买个固定域名 —— 迟早的事。）</span>
            </div>
          </div>

          <div class="logrow__names" style="margin-top:10px">
            当前公网地址：<code class="mono">{{ gateway }}</code>
          </div>
        </div>

        <!-- ④ 闲管家给我们的 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">② 闲管家给你的凭据</div>
              <div class="card__sub">
                同一个页面里的「应用概况」——<strong>这是它给你的，照抄过来</strong>
              </div>
            </div>
          </div>
          <div class="row">
            <div class="row__l">
              <div class="row__t">AppKey（对应 app_id）</div>
              <div class="row__d">一串数字，例如 677859093659717</div>
            </div>
            <div class="row__r">
              <input
                class="input mono row__in"
                :value="cfg.appId"
                placeholder="闲管家给你的 AppKey"
                @change="patch({ appId: $event.target.value })"
              />
            </div>
          </div>
          <div class="row">
            <div class="row__l">
              <div class="row__t">AppSecret（对应 app_secret）</div>
              <div class="row__d">签名用的</div>
            </div>
            <div class="row__r">
              <input
                class="input mono row__in"
                :value="cfg.appSecret"
                placeholder="闲管家给你的 AppSecret"
                @change="patch({ appSecret: $event.target.value })"
              />
            </div>
          </div>
          <div class="row row--switch">
            <div class="row__l">
              <div class="row__t">开启对接</div>
              <div class="row__d">
                关掉时闲管家的所有请求都会被拒绝（等于没有这个功能）
              </div>
            </div>
            <button
              class="switch"
              :class="{ 'switch--on': cfg.enabled }"
              @click="patch({ enabled: !cfg.enabled })"
            >
              <span class="switch__knob" />
            </button>
          </div>
        </div>

        <!-- ⑤ 安全与价格 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">安全与价格</div>
              <div class="card__sub">一般不用动，出问题时再调</div>
            </div>
          </div>

          <div class="row row--switch">
            <div class="row__l">
              <div class="row__t">只放行闲管家的 IP</div>
              <div class="row__d">
                打开时，只有闲管家官方公布的 IP 段能调进来 ——
                公网地址被人扫到也没用。<br>
                <strong>如果闲管家报「访问IP不在白名单内」，把这个关掉再试</strong>（说明它换了 IP）。
              </div>
            </div>
            <button
              class="switch"
              :class="{ 'switch--on': cfg.ipWhitelist }"
              @click="patch({ ipWhitelist: !cfg.ipWhitelist })"
            >
              <span class="switch__knob" />
            </button>
          </div>

          <div class="row">
            <div class="row__l">
              <div class="row__t">商品标价（成本价）</div>
              <div class="row__d">
                回给闲管家的 price（单位：分）。低于它的下单会被它拦下（错误码 1202）
              </div>
            </div>
            <div class="row__r">
              <input
                class="input row__in-sm"
                type="number"
                min="0"
                :value="cfg.priceFen"
                @change="patch({ priceFen: Number($event.target.value) })"
              />
              <span class="unit">分</span>
            </div>
          </div>
        </div>

        <!-- ⑥ 售卖档位 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">④ 售卖时长档位</div>
              <div class="card__sub">
                每个游戏会为这里每个档位生成一个商品。加一档不用改代码
              </div>
            </div>
          </div>
          <div class="tiers">
            <div v-for="m in state.settings.saleDurationTiers" :key="m" class="tier">
              <span class="tier__t">{{ fmtMin(m) }}</span>
              <button class="tier__x" title="删掉这一档" @click="removeTier(m)">×</button>
            </div>
            <div class="tier tier--add">
              <input
                v-model="newTier"
                class="tier__in"
                placeholder="6小时"
                @keyup.enter="addTier"
              />
              <button class="tier__add" @click="addTier">+ 加</button>
            </div>
          </div>
          <div class="hint">
            填「6小时」或「360」都行。加完之后上面的商品预览会立刻多出对应的商品。
          </div>
        </div>

        <!-- ⑥ 商品预览 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">⑤ 商品预览</div>
              <div class="card__sub">
                这就是闲管家会看到的商品。库存 = 该游戏当前空闲的账号数，没货会自动标下架
              </div>
            </div>
            <button class="btn btn--sm" @click="refreshXgj()">刷新</button>
          </div>
          <div v-if="goods.length" class="goods">
            <div class="goods__head">
              <span>商品名</span><span>库存</span><span>价格</span>
            </div>
            <div v-for="g in goods" :key="g.goodsNo" class="goods__row" :class="{ 'row--off': !g.onSale }">
              <span class="goods__name">
                {{ g.name }}
                <em class="goods__no mono">{{ g.goodsNo }}</em>
              </span>
              <span class="goods__stock" :class="g.stock ? 'stock--has' : 'stock--none'">
                {{ g.stock ? `${g.stock} 个` : '无货' }}
              </span>
              <span class="goods__price">{{ (g.price / 100).toFixed(2) }} 元</span>
            </div>
          </div>
          <div v-else class="empty">还没有商品。先在账号库里加几个带游戏名的账号。</div>
        </div>

        <!-- ⑦ 接口清单 -->
        <div class="scard">
          <div class="card__head">
            <div>
              <div class="card__title">⑥ 接口清单</div>
              <div class="card__sub">
                闲管家的服务器会调这几个地址（路径接在「接口网关」后面）
              </div>
            </div>
          </div>
          <div v-for="(p, k) in status.endpoints" :key="k" class="ep">
            <code class="ep__p mono">{{ p }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet.xgj { width: min(880px, calc(100vw - 32px)); max-height: min(88vh, 900px); }

.scard {
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  padding: 14px 16px;
  margin-bottom: 12px;
}
.card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.card__title { font-size: 14px; font-weight: 660; }
.card__sub { font-size: 11.5px; color: var(--text-3); margin-top: 3px; line-height: 1.55; }

/* 自检 */
.selfcheck { display: flex; gap: 11px; align-items: flex-start; }
.selfcheck__dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; flex: none; }
.dot--ok { background: var(--green); box-shadow: 0 0 8px var(--green); }
.dot--warn { background: var(--orange); box-shadow: 0 0 8px var(--orange); }
.selfcheck__t { font-size: 14px; font-weight: 660; }
.selfcheck__d { font-size: 11.5px; color: var(--text-3); margin-top: 3px; line-height: 1.6; }
.selfcheck--ok { border-color: rgba(48, 209, 88, 0.32); }.selfcheck--warn { border-color: rgba(255, 159, 10, 0.32); }
.miss { color: var(--orange); }

/* 请求日志 */
.logcard--empty { border-style: dashed; }
.lognum {
  font-size: 11.5px; font-weight: 600; color: var(--accent);
  background: rgba(10, 132, 255, 0.14); padding: 1px 7px; border-radius: var(--r-pill);
  margin-left: 6px;
}
.log {
  border: 1px solid var(--border); border-radius: var(--r-sm);
  overflow: hidden; max-height: 260px; overflow-y: auto;
}
.logrow {
  padding: 8px 10px; font-size: 12px;
  border-top: 1px solid var(--hairline);
}
.logrow:first-child { border-top: 0; }
.logrow--bad { background: rgba(255, 59, 48, 0.06); }
.logrow__main { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.logrow__t { color: var(--text-3); font-size: 11px; }
.logrow__what { font-weight: 600; }
.logrow__code { font-size: 11.5px; font-weight: 620; }
.code--ok { color: var(--green); }
.code--err { color: var(--red); }
.logrow__extra { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; margin-left: auto; }
.logrow__body {
  margin-top: 4px; font-size: 10.5px; color: var(--text-3);
  word-break: break-all; line-height: 1.5;
}
.logrow__names { margin-top: 4px; font-size: 11px; color: var(--text-3); line-height: 1.9; }
.namechip {
  display: inline-block; padding: 1px 6px; margin: 0 4px 2px 0;
  border-radius: var(--r-pill); background: var(--surface-2);
  border: 1px solid var(--border); color: var(--text-2); font-size: 10.5px;
}

/* 统计 */
.stats { display: flex; gap: 22px; margin: 4px 0 10px; }
.stat__n { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat__k { font-size: 11px; color: var(--text-3); margin-top: 1px; }
.gamelist { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 11.5px; padding: 3px 9px; border-radius: var(--r-pill);
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2);
}
.chip em { font-style: normal; color: var(--text-3); margin-left: 4px; }
.empty { font-size: 12px; color: var(--text-3); padding: 6px 0; line-height: 1.6; }

/* 行 */
.row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 0; border-top: 1px solid var(--border);
}
.row:first-of-type { border-top: 0; }
.row__l { flex: 1; min-width: 0; }
.row__t { font-size: 13px; font-weight: 600; }
.row__d { font-size: 11.5px; color: var(--text-3); margin-top: 2px; line-height: 1.5; }
.row__r { display: flex; align-items: center; gap: 6px; flex: none; }
.row__in { width: 250px; }
.row__in-sm { width: 100px; }
.unit { font-size: 12px; color: var(--text-3); }
.row--switch { gap: 10px; }

.code {
  font-size: 12px; padding: 6px 10px; border-radius: var(--r-xs);
  background: var(--surface-2); border: 1px solid var(--border);
  max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.code--bad { color: var(--orange); border-color: rgba(255, 159, 10, 0.45); }

/* 醒目警告框：本机地址不能填进闲管家 */
.warnbox {
  margin-top: 10px;
  padding: 11px 13px;
  border-radius: var(--r-sm);
  border: 1px solid rgba(255, 159, 10, 0.42);
  background: rgba(255, 159, 10, 0.09);
}
.warnbox__t { font-size: 13px; font-weight: 660; color: var(--orange); margin-bottom: 5px; }
.warnbox__d { font-size: 11.5px; color: var(--text-2); line-height: 1.75; }
.warnbox__d code {
  font-size: 11px; padding: 1px 5px; border-radius: 4px;
  background: var(--surface-3); color: var(--text);
}

/* 蓝色提示框（区别于橙色的警告）—— 取码链接那块用 */
.warnbox--info {
  border-color: rgba(10, 132, 255, 0.34);
  background: rgba(10, 132, 255, 0.08);
}
.warnbox--info .warnbox__t { color: var(--accent); }

/* 买家取码链接那一块：要粘进闲管家模板的那几行 */
.tplbox {
  margin: 8px 0 12px;
  padding: 12px 13px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
}
.muted { color: var(--text-3); }

/* 开关 */
.switch {
  width: 46px; height: 27px; border-radius: 14px; border: 1px solid var(--border-2);
  background: var(--surface-2); position: relative; cursor: pointer; flex: none;
  transition: background 180ms var(--ease-out);
}
.switch--on { background: var(--green); border-color: var(--green); }
.switch__knob {
  position: absolute; top: 2px; left: 2px; width: 21px; height: 21px;
  border-radius: 50%; background: #fff; transition: transform 180ms var(--ease-spring);
}
.switch--on .switch__knob { transform: translateX(19px); }

/* 档位 */
.tiers { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.tier {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 8px 5px 11px; border-radius: var(--r-pill);
  background: var(--surface-2); border: 1px solid var(--border);
  font-size: 12.5px;
}
.tier__t { font-weight: 600; }
.tier__x {
  width: 18px; height: 18px; border-radius: 50%; border: 0;
  background: transparent; color: var(--text-3); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0;
}
.tier__x:hover { background: var(--red-soft); color: var(--red); }
.tier--add { padding: 0; background: transparent; border-style: dashed; }
.tier__in {
  width: 72px; height: 30px; padding: 0 9px; font-size: 12.5px;
  background: transparent; border: 0; color: var(--text); outline: none;
}
.tier__add {
  height: 30px; padding: 0 11px; border: 0; border-radius: var(--r-pill);
  background: transparent; color: var(--accent); cursor: pointer; font-size: 12.5px; font-weight: 600;
}
.hint { font-size: 11.5px; color: var(--text-3); margin-top: 9px; line-height: 1.6; }

/* 商品表 */
.goods { border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; }
.goods__head, .goods__row {
  display: grid; grid-template-columns: 1fr 84px 84px;
  gap: 8px; padding: 8px 11px; align-items: center;
}
.goods__head {
  font-size: 11px; color: var(--text-3); font-weight: 600;
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.goods__row { font-size: 12.5px; border-top: 1px solid var(--hairline); }
.goods__row:first-of-type { border-top: 0; }
.row--off { opacity: 0.5; }
.goods__name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.goods__no { font-size: 10.5px; color: var(--text-3); font-style: normal; }
.goods__stock { font-weight: 600; }
.stock--has { color: var(--green); }
.stock--none { color: var(--text-3); }
.goods__price { color: var(--text-2); font-variant-numeric: tabular-nums; }

.ep { padding: 4px 0; }
.ep__p { font-size: 12px; color: var(--text-2); }

@media (max-width: 620px) {
  .row { flex-direction: column; align-items: flex-start; }
  .row__r { width: 100%; flex-wrap: wrap; }
  .row__in { width: 100%; }
  .code { max-width: none; flex: 1; }
  .goods__head, .goods__row { grid-template-columns: 1fr 62px 62px; font-size: 12px; }
}
</style>
