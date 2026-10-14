<script setup>
/**
 * 管理器说明 —— 给使用者看的功能与用法手册。
 *
 * ★ 这个界面刻意只讲「怎么用」，不讲怎么做 ★
 *   通篇不出现任何技术性的词（接口名、字段名、参数、行内术语等一律没有），
 *   面向的是每天要用它发货、收号、改密的人 —— 不是写它的人。
 *   所有按钮名、面板名都跟界面上真实的一模一样，照着念就能找到。
 *
 * 加内容：往 SECTIONS 里加一段就行，左边目录和上面的搜索会自动带上。
 */
import { ref, computed } from 'vue';

const emit = defineEmits(['close']);

const q = ref('');
const openKeys = ref(['start']);

const SECTIONS = [
  {
    key: 'start',
    icon: '🧭',
    title: '一分钟看懂它替你做什么',
    blocks: [
      {
        p: '这套管理器管一件事：<b>你手里的 Steam 账号，什么时候可以卖、卖给谁、卖完怎么收回来。</b>',
      },
      {
        p: '它把每个账号都看成处在三种情况之一，账号只会待在其中一种里，不会两边都出现：',
      },
      {
        steps: [
          ['可用', '账号闲着，可以卖。这是你的「库存」。'],
          ['使用中', '已经卖出去，买家正在用，界面在倒计时。'],
          ['待改密', '买家时间用完了，得先把密码换掉，换完才能重新变成「可用」。'],
        ],
      },
      {
        p: '转一圈是这样的：<b>可用 →（点开始使用）→ 使用中 →（时间到）→ 待改密 →（密码换好）→ 回到可用</b>。',
      },
      {
        note: '三条界面标签上都有数字，分别是三种情况各有多少个账号。哪边有活没干完，标签上还会亮一个小圆点提醒你。',
      },
    ],
  },
  {
    key: 'screen',
    icon: '🗂',
    title: '界面怎么逛',
    blocks: [
      { h: '顶上那条' },
      {
        steps: [
          ['可用 ｜ 使用中 ｜ 待改密', '三个主要界面，点一下就切过去；鼠标拖着横滑、触控板左右滑、手机上用手指划，也一样能切。'],
          ['更多', '里面放的是不常开的那些：批量导入、今日使用记录、邮箱、把账号清单导出、设置。'],
          ['右边的加号', '添加一个新账号。'],
          ['右上角「⋯」', '也是这些附加功能，另外多了「切换深浅色」和「锁定」。'],
        ],
      },
      { h: '卡片上能做的事' },
      {
        steps: [
          ['开始使用', '在「可用」的卡片上。点了它就进入倒计时，同时把账号和密码摆出来给你复制。'],
          ['提前结束', '在「使用中」的卡片上。买家提前还号了，点它就把账号放回「可用」，不用等时间到。'],
          ['手动改密', '在「待改密」的卡片上。你自己去 Steam 把密码换掉，再把新密码填回来。'],
          ['跳过改密', '不想换密码，直接把它放回「可用」，密码保持原样。'],
          ['铅笔', '编辑这个账号的信息。'],
          ['删除', '把这个账号连同它的记录一起从本地清掉，删掉了找不回来。'],
        ],
      },
      {
        note: '某个界面里账号多的时候，可以直接在顶部搜索框打字，按账号名或游戏名筛。',
      },
    ],
  },
  {
    key: 'add',
    icon: '➕',
    title: '添加账号',
    blocks: [
      { p: '点右上角的加号，填这几样：' },
      {
        steps: [
          ['账号', '必填。'],
          ['密码', '必填。懒得想就点旁边的生成按钮，它会给你一串 10 到 12 位、字母打头、大小写和数字都有的随机密码。'],
          ['使用时间', '必填。这就是「这个号能卖出去多久」。可以填分钟、小时或天，也能直接点旁边的快捷档位。'],
          ['游戏名', '卖的是什么游戏。这一栏很重要，见下面「卖货」那一节。'],
          ['备注', '写给自己看的，比如「一号机」「排位号」。'],
          ['验证邮件收在哪个邮箱', '选一个已经加进来的邮箱。这是后面自动取验证码的命根子，见「验证码」那一节。'],
        ],
      },
      {
        note: '点保存之后账号立刻出现在「可用」里，<b>不用刷新页面</b>，还会顺便告诉你它是今天第几个被使用的账号。',
      },
    ],
  },
  {
    key: 'use',
    icon: '▶',
    title: '开始使用与倒计时',
    blocks: [
      {
        p: '在「可用」里找到账号，点「开始使用」。会发生三件事：',
      },
      {
        steps: [
          ['账号挪到「使用中」', '它不在「可用」里了，也就是这段时间不能再卖给别人。'],
          ['弹出一张凭据卡', '上面按「账号：」「密码：」两行摆好，可以直接复制。'],
          ['倒计时开始走', '倒计时长度就是添加账号时填的「使用时间」。'],
        ],
      },
      {
        note: '时间从你点「开始使用」那一刻算起。同一个账号能接任意时长的单 —— 如果是从闲鱼订单进来的，它会自动按买家买的时长来计时，不用你提前给每个时长都备货。',
      },
      {
        h: '时间到了会自己往下走',
      },
      {
        p: '倒计时归零，账号<b>自动</b>从「使用中」进到「待改密」，不需要你盯着点。这时候界面右上角的「今日已用」也会跟着加一。',
      },
      {
        note: '想让账号在「使用中」多待一会儿，在它自己那个账号上把使用时间改长一点即可；想让它快点走完流程测试，添加时把使用时间填 1 分钟。',
      },
    ],
  },
  {
    key: 'pw',
    icon: '🔑',
    title: '改密码（把号收回来）',
    blocks: [
      {
        p: '账号进到「待改密」，意思就是：该换密码了。换完密码它才会回到「可用」，才能再卖下一单。有两条路：',
      },
      { h: '第一条：交给机器人自动做' },
      {
        p: '这是省事的那条。机器人会自己去 Steam 走完整个换密码流程，遇到要验证码时它会去邮箱里取，取完密码它直接把新密码存回来。全程你不用管，<b>账号自动回到「可用」</b>。',
      },
      {
        note: '机器人是谁开的、有没有在跑，看「待改密」卡片上写的处理人名字。它需要一直开着 —— 关掉的话账号就会卡在「待改密」出不来，等于这个号暂时卖不了。',
      },
      { h: '第二条：你自己动手' },
      {
        steps: [
          ['手动改密', '点卡片上的它，你自己去 Steam 换好密码，回来把新密码填进框里保存。'],
          ['跳过改密', '这一单不用换密码（比如是测试、或者这个号你另有安排），点它直接放回「可用」，密码保持原样。'],
        ],
      },
      {
        note: '改密失败不要慌。界面上会看到失败原因，账号会留在「待改密」等你处理 —— 它不会悄悄消失，也不会被误当成「可用」卖出去。',
      },
    ],
  },
  {
    key: 'import',
    icon: '📥',
    title: '批量导入账号',
    blocks: [
      {
        p: '一次要录几十个号的时候用这个。「更多 → 批量导入」打开，把文本粘进去，点一下就好了。它认好几种写法，怎么方便怎么来。',
      },
      { h: '写法一：一行一个账号（最快）' },
      {
        steps: [
          ['账号 -- 密码', '最少填这两样。'],
          ['账号 -- 密码 -- 邮箱', '第三段带 @ 就当邮箱。'],
          ['账号 -- 密码 -- 游戏名', '第三段不带 @ 就当游戏名。'],
          ['账号 -- 密码 -- 邮箱 -- 游戏名', '四段全填。'],
        ],
      },
      {
        note: '中间那几个横杠写两个、四个、破折号、逗号、分号或者按一下 Tab 键，它都认，不用特意对齐。',
      },
      { h: '写法二：分标签写（最清楚）' },
      {
        p: '一个账号写一小段，每行一个标签，账号之间空一行隔开。标签名字很好记：账号、密码、游戏、使用时间、备注。',
      },
      {
        note: '游戏名、备注可以空着；账号和密码必须有。<b>「使用时间」这一栏决定这个号能卖多久</b>，别忘了填。',
      },
      {
        p: '导入之前它会告诉你「识别到 N 个账号」，对一下数量再确认。导入错了就直接删掉重来，不影响别的账号。',
      },
      {
        note: '<b>导入完千万别忘了把账号和邮箱连起来。</b>见下面「验证码」那一节第一条。',
      },
    ],
  },
  {
    key: 'today',
    icon: '📊',
    title: '今日使用记录',
    blocks: [
      { p: '「更多 → 今日使用记录」，看今天这一天的流水。顶部四个数字分别是：' },
      {
        steps: [
          ['今天被使用的次数', '今天一共点了几次「开始使用」，点了又提前结束的也算。'],
          ['去重账号', '这些次数涉及几个不同的账号。'],
          ['累计时长', '今天这些账号一共被用了多久。'],
          ['今日已改密', '今天真正把密码换完了几次（自动的和手动的一起算）。'],
        ],
      },
      {
        p: '下面按顺序列出每一个：第几个用的、几点开始、几点结束、用了多久、现在是什么状态。还在用着的会标出来，旁边就有「提前结束」。',
      },
      {
        note: '顶栏上那个「今日已用 N」和这里是同一个口径 —— 点了几次「开始使用」就算几次。而下一位买家拿到的号，会显示成「今天第 N+1 个」。',
      },
    ],
  },
  {
    key: 'mail',
    icon: '📮',
    title: '验证码（买家登录要用的）',
    blocks: [
      {
        p: '先说清楚为什么需要它：买家拿到账号，第一次在新设备登录 Steam 时，Steam 会把一个验证码发到<b>账号绑定的邮箱</b>里 —— 而那个邮箱买家是打不开的。所以这套管理器替他去邮箱把码取出来。',
      },
      {
        note: '同一件事有两处要用到邮箱：买家登录时取码，和机器人换密码时取码。所以邮箱必须配好，账号也必须连上邮箱。',
      },
      { h: '★ 最容易漏的一步 ★' },
      {
        p: '导入或添加完账号以后，去编辑那个账号，在「验证邮件收在哪个邮箱」里选上对应的邮箱，然后<b>一定要点保存</b>。',
      },
      {
        p: '怎么确认连上了：在「可用」或「使用中」看这个账号，它下面会显示绑的邮箱。如果显示「未关联邮箱」，就是没连上，回去重做一遍。',
      },
      {
        note: '账号自己填的邮箱地址，和收件邮箱的地址，<b>必须一模一样</b>。对不上的话，码取不到。漏了这一步的后果很直接：买家点开取码链接一直显示没有验证码；账号到点了机器人也改不了密，卡在「待改密」回不来。',
      },
      { h: '怎么加一个收件邮箱' },
      {
        p: '「更多 → 邮箱」，点添加。按你手上邮箱的类型选：',
      },
      {
        steps: [
          ['微软邮箱', 'outlook、hotmail、live 这类，填两样东西就能用。'],
          ['取件链接', 'iCloud 这类没有现成办法的，把服务商给你的那一整行直接粘进去，它会自己把地址和邮箱分开认出来。'],
        ],
      },
      {
        note: '那一整行里带着能读这个邮箱的钥匙，<b>谁看到谁就能读它的全部邮件</b>。管理器会把它锁起来、不会显示出来，但你也不要往别处贴。建议专门用一个邮箱来收验证码，别拿自己常用的主邮箱。',
      },
      { h: '加完之后' },
      {
        steps: [
          ['拉取邮件', '点一下，看看能不能真的收到信。'],
          ['查看邮件', '展开能看到完整内容，每封 Steam 邮件后面会直接标出它认出来的验证码，方便你核对认对没有。'],
          ['关联到账号', '回到账号里选上这个邮箱，见上面那条。'],
        ],
      },
      {
        note: '有一件事是故意的：<b>换密码用的验证码不会给买家</b>，只给登录用的。因为买家手里本来就有账号密码，要是再让他拿到换密码的码，他就能把号改走。拿不准的时候，它宁可显示「暂时没有验证码」也不会给错。看到这种情况不要当成故障。',
      },
    ],
  },
  {
    key: 'sell',
    icon: '🛒',
    title: '卖货：闲管家对接',
    blocks: [
      {
        p: '「更多 → 闲管家对接」是管你闲鱼那边的售卖。买家拍下付款之后，闲管家会来这里要一个账号，管理器从「可用」里挑一个发出去，账号随即进入「使用中」开始计时。',
      },
      {
        p: '面板最上面那条会直接告诉你现在能不能卖：<b>「✓ 可以对接了」就是通了</b>；写着「还差几项配置」它会告诉你差什么。',
      },
      { h: '商品是怎么来的' },
      {
        p: '商品是<b>自动长出来的</b>，你不用一个个建：游戏名是从你账号库里读出来的，时长档位是你在面板里配的那几档，两样一组合就是商品。',
      },
      {
        p: '所以<b>加一个新游戏只要导入那个游戏的账号就行了</b>，商品立刻多出来。面板里能看到「游戏几个、档位几个、商品几个」，下面还有商品预览。',
      },
      {
        note: '一个游戏至少要有一个「可用」的账号，它的商品才算在架上。库存显示的就是这个游戏空闲账号的数量，卖到 0 商品会自动下架，也就是暂时卖不动了。',
      },
      {
        note: '<b>游戏名一旦用了就别改。</b>商品是跟着游戏名走的，改了名字，闲管家那边原来关联好的商品就对不上了，会发不出货。确实要改的话先问问再动。',
      },
      { h: '卖出去之后' },
      {
        p: '账号进入「使用中」，倒计时按买家买的那一档走。买家时间用完，账号自动进「待改密」，机器人把密码换掉，再回到「可用」，等着接下一单。整个过程不用你手动插手。',
      },
      {
        p: '买家需要验证码的时候，给他一条专属链接，他点开就能看到自己的码。这条链接是面板里的「买家取码链接」，复制那行填到闲管家发货消息的模板里。',
      },
      { h: '没人来要货怎么查' },
      {
        p: '面板上有一块「闲管家调我们的记录」，这是排查第一现场：',
      },
      {
        steps: [
          ['一条记录都没有', '说明它压根没联系上你。去它后台看地址填对没有、应用是不是已上线。'],
          ['有记录但写着失败', '它联系上了，是被这边挡回去了，记录里会写明原因。'],
        ],
      },
      {
        note: '那个「公网上能访问的地址」是临时的，<b>每次重新开隧道都会换一个</b>。换了以后闲管家那边有两处要改：填地址的那一格，和发货消息模板里的取码链接。忘了改的表现就是买家下单发不了货、或者取码链接打不开。',
      },
    ],
  },
  {
    key: 'export',
    icon: '📤',
    title: '导出与备份',
    blocks: [
      { h: '导出账号清单' },
      {
        p: '「更多 → 导出全部账号」，或者设置里那三个按钮，可以把账号清单存成文件带出去。三种样式：人看着顺眼的、给表格用的、和结构化的。',
      },
      {
        note: '<b>导出去的是明文，账号密码一眼就能看到。</b>用完请及时删掉，别留在桌面或者聊天记录里。',
      },
      { h: '备份' },
      {
        p: '你的全部账号、邮箱、设置、售卖记录，都在同一个文件里。想备份就把它拷走，换电脑时一起带过去，用同一个主密码打开，东西都在。',
      },
      {
        note: '建议定期备份。<b>主密码忘了没有任何办法找回</b> —— 这是刻意这么设计的，也正因为这样，别人拿到你的备份文件也打不开。',
      },
    ],
  },
  {
    key: 'settings',
    icon: '⚙',
    title: '设置',
    blocks: [
      {
        steps: [
          ['开始使用时自动复制', '打开后，点「开始使用」会自动把「账号 / 密码」那一段复制好，直接就能粘给买家。'],
          ['闲置自动锁库', '多久没操作就自动锁上，要重新输主密码才能进。填 0 就是不锁。'],
          ['提醒推送', '有账号时间到、进入「待改密」的时候，往你填的地址推一条通知，让你的程序立刻知道。填好以后可以点「发送测试」验一下。'],
          ['修改主密码', '改完会用新密码把全部账号重新锁一遍，原来打开的窗口都会失效。'],
          ['界面主题', '深色和浅色，随你喜欢。'],
        ],
      },
      {
        note: '「自动化接入密钥」是给别的程序来取号用的钥匙，在设置和专门的那个面板里都能看到、能重置。它等于所有账号密码，别给别人看，更别贴到网上去。',
      },
    ],
  },
  {
    key: 'safety',
    icon: '🛡',
    title: '几条要养成习惯的',
    blocks: [
      {
        steps: [
          ['主密码别忘', '忘了就真打不开了，没人能帮你恢复。用一个自己记得住、别人猜不到的。'],
          ['号与邮箱要连上', '导入完就顺手连上，漏一次就可能赔一单。'],
          ['别改游戏名', '改了商品关联就断，发不出货。'],
          ['导出的文件及时删', '那是明文。'],
          ['机器人一直开着', '关了账号就会卡在「待改密」，回不到「可用」。'],
          ['发货消息里写上「请勿修改密码」', '买家自己去改密码的话，机器人就用旧密码登不上了，这个号会卡住。'],
        ],
      },
      {
        p: '每天扫一眼就够：看看「可用」还剩几个（这就是你还能接多少单）、「待改密」里有没有卡很久的、机器人窗口有没有在报错。',
      },
    ],
  },
];

/* 搜索：匹配标题或正文里的关键词 */
const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  if (!kw) return SECTIONS;
  const hit = (s) => {
    if (s.title.toLowerCase().includes(kw)) return true;
    return s.blocks.some((b) => {
      const bag = [];
      if (b.p) bag.push(b.p);
      if (b.h) bag.push(b.h);
      if (b.note) bag.push(b.note);
      if (b.steps) b.steps.forEach(([t, d]) => bag.push(t, d));
      return bag.join(' ').toLowerCase().includes(kw);
    });
  };
  return SECTIONS.filter(hit);
});

const openCount = computed(() => openKeys.value.length);

function toggle(key) {
  const i = openKeys.value.indexOf(key);
  if (i >= 0) openKeys.value.splice(i, 1);
  else openKeys.value.push(key);
}

function expandAll() {
  openKeys.value = SECTIONS.map((s) => s.key);
}

function collapseAll() {
  openKeys.value = [];
}

/** 点左边目录：展开它、滚过去 */
function jump(key) {
  if (!openKeys.value.includes(key)) openKeys.value.push(key);
  requestAnimationFrame(() => {
    const el = document.getElementById(`help-${key}`);
    if (!el) return;
    // ★ 不能只靠 scrollIntoView ★
    //   正文是嵌在弹层内部那个可滚动区域里的，scrollIntoView 会去滚它的祖先，
    //   结果段落根本没动（实测点目录没反应）。这里自己算滚动位置。
    const box = el.closest('.sheet__body');
    const offset = box
      ? el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
      : el.offsetTop - 12;
    (box || window).scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  });
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="sheet help pop-in">
      <div class="sheet__head">
        <div>
          <div class="sheet__title">管理器说明</div>
          <div class="sheet__sub">
            每个功能是干什么的、在哪里、怎么用 —— 对着界面念就能找到
          </div>
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      <div class="sheet__body">
        <div class="help__bar">
          <input
            v-model="q"
            class="input help__search"
            placeholder="找功能，例如：邮箱 / 倒计时 / 导出"
            @keyup.enter="expandAll"
          />
          <button class="btn btn--sm" @click="expandAll">全部展开</button>
          <button class="btn btn--sm" @click="collapseAll">全部收起</button>
        </div>

        <p v-if="q.trim()" class="help__hit">
          找到 <strong>{{ filtered.length }}</strong> 段相关内容
          <span v-if="!filtered.length"> —— 换个词试试</span>
        </p>

        <div class="help__layout">
          <!-- 左边目录 -->
          <nav class="toc">
            <div class="toc__label">目录</div>
            <button
              v-for="s in filtered"
              :key="s.key"
              class="toc__item"
              @click="jump(s.key)"
            >
              <span class="toc__icon">{{ s.icon }}</span>
              <span class="toc__t">{{ s.title }}</span>
            </button>
          </nav>

          <!-- 右边正文 -->
          <div class="help__main">
            <div v-if="!filtered.length" class="empty">
              <div class="empty__icon">🔍</div>
              <div class="empty__title">没找到相关的内容</div>
              <div class="empty__text">试试更短的词，比如「邮箱」「时间」「导出」。</div>
            </div>

            <section
              v-for="s in filtered"
              :id="`help-${s.key}`"
              :key="s.key"
              class="sec"
              :class="{ 'sec--open': openKeys.includes(s.key) }"
            >
              <button class="sec__head" @click="toggle(s.key)">
                <span class="sec__icon">{{ s.icon }}</span>
                <span class="sec__title">{{ s.title }}</span>
                <span class="sec__caret">{{ openKeys.includes(s.key) ? '▾' : '▸' }}</span>
              </button>

              <div v-show="openKeys.includes(s.key)" class="sec__body">
                <template v-for="(b, i) in s.blocks" :key="i">
                  <div v-if="b.h" class="blk__h">{{ b.h }}</div>

                  <p v-if="b.p" class="blk__p" v-html="b.p" />

                  <div v-if="b.steps" class="steps">
                    <div v-for="(st, j) in b.steps" :key="j" class="step">
                      <div class="step__k">{{ st[0] }}</div>
                      <div class="step__d">{{ st[1] }}</div>
                    </div>
                  </div>

                  <div v-if="b.note" class="note">
                    <span class="note__i">ⓘ</span>
                    <span class="note__t" v-html="b.note" />
                  </div>
                </template>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div class="sheet__foot">
        <span class="foot__hint">已展开 {{ openCount }} / {{ SECTIONS.length }} 段</span>
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet.help { width: min(960px, calc(100vw - 32px)); max-height: min(88vh, 900px); }
.sheet.help :deep(.sheet__body) { padding-bottom: 22px; }

/* 顶栏：搜索 */
.help__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 12px;
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 0;
  background: linear-gradient(var(--surface-2) 72%, transparent);
}
.help__search { flex: 1; height: 36px; font-size: 13px; }
.help__hit { font-size: 12px; color: var(--text-3); margin: 0 0 10px; }

/* 两栏 */
.help__layout { display: flex; gap: 20px; align-items: flex-start; }

.toc {
  flex: none;
  width: 190px;
  position: sticky;
  top: 66px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toc__label {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--text-3);
  padding: 0 8px; margin-bottom: 5px;
}
.toc__item {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 9px; border: 0; border-radius: var(--r-xs);
  background: transparent; color: var(--text-2);
  font-size: 12.5px; text-align: left; cursor: pointer;
  transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
}
.toc__item:hover { background: var(--surface); color: var(--text); }
.toc__icon { flex: none; font-size: 13px; opacity: 0.85; }
.toc__t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.help__main { flex: 1; min-width: 0; }

/* 段落卡片 */
.sec {
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  margin-bottom: 10px;
  overflow: hidden;
  scroll-margin-top: 70px;
}
.sec--open { border-color: var(--border-2); }

.sec__head {
  width: 100%;
  display: flex; align-items: center; gap: 10px;
  padding: 13px 15px;
  border: 0; background: transparent;
  color: var(--text); cursor: pointer; text-align: left;
}
.sec__head:hover { background: var(--surface-2); }
.sec__icon { flex: none; font-size: 15px; }
.sec__title { flex: 1; font-size: 14px; font-weight: 680; letter-spacing: -0.02em; }
.sec__caret { flex: none; color: var(--text-3); font-size: 11px; }

.sec__body { padding: 2px 15px 15px; }

.blk__h {
  font-size: 12px; font-weight: 680; color: var(--text);
  margin: 14px 0 7px;
  padding-left: 9px;
  border-left: 2px solid var(--accent);
}
.blk__h:first-child { margin-top: 6px; }

.blk__p { font-size: 12.5px; line-height: 1.75; color: var(--text-2); margin: 0 0 8px; }
.blk__p :deep(b) { color: var(--text); font-weight: 640; }

/* 条目 */
.steps { display: flex; flex-direction: column; gap: 7px; margin: 9px 0; }
.step {
  display: flex; gap: 10px; align-items: baseline;
  padding: 8px 11px;
  border-radius: var(--r-xs);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.step__k {
  flex: none; min-width: 74px; max-width: 150px;
  font-size: 12px; font-weight: 660; color: var(--accent);
}
.step__d { font-size: 12px; line-height: 1.65; color: var(--text-2); }

/* 提示 */
.note {
  display: flex; gap: 9px; align-items: flex-start;
  margin: 9px 0;
  padding: 9px 12px;
  border-radius: var(--r-xs);
  background: rgba(10, 132, 255, 0.07);
  border: 1px solid rgba(10, 132, 255, 0.2);
}
.note__i { flex: none; color: var(--accent); font-size: 12px; line-height: 1.6; }
.note__t { font-size: 11.5px; line-height: 1.7; color: var(--text-2); }
.note__t :deep(b) { color: var(--text); font-weight: 650; }

/* 底栏 */
.foot__hint { margin-right: auto; font-size: 11.5px; color: var(--text-3); align-self: center; }

@media (max-width: 760px) {
  .help__layout { flex-direction: column; gap: 12px; }
  .toc {
    position: static; width: 100%;
    flex-direction: row; flex-wrap: wrap; gap: 5px;
  }
  .toc__label { display: none; }
  .toc__item {
    background: var(--surface); border: 1px solid var(--border);
    font-size: 12px; padding: 6px 10px;
  }
  .step { flex-direction: column; gap: 3px; }
  .step__k { max-width: none; }
  .help__bar { flex-wrap: wrap; }
  .help__search { width: 100%; flex: none; }
}
</style>
