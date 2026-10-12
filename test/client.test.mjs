/**
 * 浏览器半端的集成测试。
 *
 * 在 Node 里把真实的 client.js 跑起来，桩掉 window.__ModuleLoader__ 和 React。
 * 这样不用开浏览器就能验证四件事：
 *   1. 包体能被模块加载器接住，factory 不抛错
 *   2. 注册的槽位名/id/order 完全正确（注册到未声明的槽位会在加载时抛错）
 *   3. 组件在真实投影数据下渲染出正确的数字，没数据时渲染 null
 *   4. 框架没给 useProjection 时明确报出来，不静默消失
 *
 * 顺带守住 AGENTS.md 里那两条客户端命门：
 * bundle 里 require 的每个 specifier 都要能被模块表答上（这里用严格桩卡住），
 * 以及 exports 必须带 ./package.json。
 *
 * 投影的字段名与形状以宿主实现为准：
 *   tokenUsage      = dsh-token-meter 的 wire view（state.totals），四个扁平桶
 *   contextPressure = 同上的 wire view，含 projectedTokens / pressureTokens / contextWindow
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** 极简 React 桩：够跑一次渲染，并保留 hook 槽位让状态能跨两次渲染保持。 */
function createReactStub() {
  const hooks = [];
  let cursor = 0;
  return {
    __resetCursor() {
      cursor = 0;
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: Object.assign({}, props || {}, {
          children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
        }),
      };
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [
        hooks[i],
        (next) => {
          hooks[i] = typeof next === 'function' ? next(hooks[i]) : next;
        },
      ];
    },
    useEffect() {
      cursor++; // 占位，保持 hook 顺序
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
  };
}

/** 把渲染树里的文本收集出来，便于断言。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out);
  return out;
}

/** 按类型找第一个元素。 */
function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === type) return node;
  return find(node.props && node.props.children, type);
}

/** 严格 require 桩：答不上就抛错，模拟真实加载器。 */
function makeRequire(react) {
  const table = { react };
  return (name) => {
    if (!(name in table)) throw new Error(`missed the module table: ${name}`);
    return table[name];
  };
}

/** 跑一次加载，返回 { id, factory }。 */
async function loadBundle() {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(config) {
        captured = config;
      },
    },
  };
  // 每次用查询串绕开模块缓存，保证重复调用都会重新执行包体
  await import(`../client.js?t=${Date.now()}${Math.random()}`);
  assert.ok(captured, '包体没有调用 window.__ModuleLoader__.load');
  return captured;
}

/** 装配一次注册，返回被注册的组件。 */
async function registeredComponent() {
  const cfg = await loadBundle();
  const react = createReactStub();
  const mod = cfg.factory(makeRequire(react));
  let registered = null;
  mod.apply({
    slots: {
      inject: (_n, f) => f(),
      register: (options, component) => {
        registered = { options, component };
        return () => {};
      },
    },
  });
  assert.ok(registered, '没有发生注册');
  return { component: registered.component, options: registered.options, react };
}

/**
 * 主夹具。数字能整除，方便手算：
 *   已计费输入 = 990,000 + 10,000 = 1,000,000，命中率 0.99
 *   每步平均输出 = 100,000 / 100 = 1,000
 *   下一次请求上下文 = 1,000,000（占满 1M 窗口）
 */
const FIXTURES = {
  tokenUsage: {
    cacheReadTokens: 990000,
    uncachedInputTokens: 10000,
    cacheWriteTokens: 0,
    outputTokens: 100000,
  },
  sessionStats: { turns: 10, steps: 100 },
  contextPressure: { projectedTokens: 1000000, contextWindow: 1000000 },
};

/** 钉死在北京时间 2026-10-12 20:00（周一，空闲时段），否则结果随时钟漂。 */
const OFF_PEAK_NOW = new Date(Date.UTC(2026, 9, 12, 12, 0));

/**
 * 临时把全局时钟钉在某一刻，执行完再还原。
 *
 * 组件内部用 `new Date()` 判断峰谷时段，而包体外壳没有传时钟进去。
 * 测试要断言具体金额，就必须让"现在"是确定的——所以临时替换 globalThis.Date。
 */
function withFakeClock(fixedNow, fn) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedNow.getTime());
      else super(...args);
    }
    static now() {
      return fixedNow.getTime();
    }
  }
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

describe('包体与注册契约', () => {
  test('manifest 带 ./package.json 导出（缺了会被静默跳过）', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.ok(pkg.exports['./package.json'], 'exports 缺少 ./package.json');
    assert.ok(pkg.exports['./client'], 'exports 缺少 ./client');
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.ok(
      pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
      'client.inject 必须声明依赖的宿主包',
    );
  });

  test('包体加载出的 id 与包名一致', async () => {
    const cfg = await loadBundle();
    assert.equal(cfg.id, 'dsh-costcast');
    assert.equal(typeof cfg.factory, 'function');
  });

  test('factory 只 require 模块表里有的东西', async () => {
    const cfg = await loadBundle();
    const mod = cfg.factory(makeRequire(createReactStub()));
    assert.ok(mod, 'factory 没有返回模块');
  });

  test('模块声明 inject: [slots]', async () => {
    const cfg = await loadBundle();
    const mod = cfg.factory(makeRequire(createReactStub()));
    assert.deepEqual(mod.inject, ['slots']);
    assert.equal(typeof mod.apply, 'function');
  });

  test('注册到 conversation.input.dock，id 与 order 正确', async () => {
    const { options } = await registeredComponent();
    assert.equal(options.name, 'conversation.input.dock');
    assert.equal(options.id, 'costcast');
    assert.equal(options.order, 5);
  });
});

describe('组件渲染', () => {
  async function render(projections) {
    const { component, react } = await registeredComponent();
    react.__resetCursor();
    return withFakeClock(OFF_PEAK_NOW, () => component({ useProjection: (name) => projections[name] }));
  }

  test('完整数据下渲染出读数条，数字与手算一致', async () => {
    const tree = await render(FIXTURES);
    assert.ok(tree, '应当渲染出内容');
    const text = collectText(tree).join(' ');

    assert.match(text, /上下文/);
    assert.match(text, /1M/);
    assert.match(text, /下一步/);
    assert.match(text, /¥0\.032–0\.036/); // 0.0318 ~ 0.0358
    assert.match(text, /本轮/);
    assert.match(text, /¥0\.19–0\.54/); // 0.1908 ~ 0.537
    assert.match(text, /空闲价/);
  });

  test('没有数据时渲染 null，不给假数字', async () => {
    const tree = await render({});
    assert.equal(tree, null);
  });

  test('只有上下文、没有用量时仍渲染，本轮显示破折号', async () => {
    const tree = await render({
      contextPressure: { projectedTokens: 20000, contextWindow: 1000000 },
    });
    const text = collectText(tree).join(' ');
    assert.match(text, /本轮/);
    assert.match(text, /—/);
  });

  test('框架没给 useProjection 时明确报出来', async () => {
    const { component, react } = await registeredComponent();
    react.__resetCursor();
    const tree = withFakeClock(OFF_PEAK_NOW, () => component({}));
    const text = collectText(tree).join(' ');
    assert.match(text, /拿不到投影接口/);
  });

  test('点开后出现成本明细，含累计与三桶拆解', async () => {
    const { component, react } = await registeredComponent();
    const props = { useProjection: (name) => FIXTURES[name] };

    react.__resetCursor();
    const collapsed = withFakeClock(OFF_PEAK_NOW, () => component(props));
    assert.ok(!find(collapsed, 'dialog'), '默认应当是收起的');

    const button = find(collapsed, 'button');
    assert.ok(button, '读数条应当是个按钮');
    button.props.onClick();

    react.__resetCursor();
    const expanded = withFakeClock(OFF_PEAK_NOW, () => component(props));
    const text = collectText(expanded).join(' ');

    assert.match(text, /成本预估/);
    assert.match(text, /会话累计/);
    assert.match(text, /¥0\.43/); // 0.4298
    assert.match(text, /缓存读/);
    assert.match(text, /990K/);
    assert.match(text, /¥0\.020/); // 0.0198
    assert.match(text, /输出/);
    assert.match(text, /100K/);
    assert.match(text, /¥0\.40/); // 0.4
    assert.match(text, /未缓存/);
    assert.match(text, /10K/);
    assert.match(text, /¥0\.010/); // 0.01
    // 上下文占满窗口 → 给出开新会话的提示
    assert.match(text, /上下文已占 100%/);
  });
});
