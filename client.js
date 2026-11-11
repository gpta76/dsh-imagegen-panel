window.__ModuleLoader__.load({
  id: 'dsh-imagegen-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useSyncExternalStore = React.useSyncExternalStore

    const ROUTE = '/imagegen'

    /* ------------------------------------------------------------------ store */

    const PRESETS = [
      {
        key: 'front',
        label: '正面全身（锚点）',
        hint: '角色资产的第一张，后面所有视图都拿它当参考图',
        size: '1024x1536',
        text: '正面全身站姿，双脚并拢，双臂自然下垂，正对镜头，纯白背景，全身完整入画，角色设定图，写实国风，柔和冷光，细节清晰',
      },
      {
        key: 'turnaround',
        label: '三视图',
        hint: '同一角色的正 / 侧 / 背，做设定集用',
        size: '1536x1024',
        text: '同一角色的三视图（正面、侧面、背面），全身入画，等距并排，纯白背景，角色设定图，比例一致，写实国风',
      },
      {
        key: 'head',
        label: '大头照',
        hint: '肩部以上，用于头像与表情参考',
        size: '1024x1280',
        text: '正面半身大头照，肩部以上，表情平静，纯白背景，角色设定图，写实国风，细节清晰',
      },
      {
        key: 'side',
        label: '侧身',
        size: '1024x1536',
        text: '侧面全身站姿，90 度侧脸，纯白背景，全身完整入画，角色设定图，写实国风',
      },
      {
        key: 'back',
        label: '背面',
        size: '1024x1536',
        text: '背面全身站姿，看不到脸，纯白背景，全身完整入画，角色设定图，写实国风',
      },
      {
        key: 'detail',
        label: '细节 / 表情',
        size: '1024x1024',
        text: '面部与服饰细节特写，表情生动，纯白背景，角色设定图，写实国风，高清质感',
      },
      {
        key: 'sheet',
        label: '角色档案板',
        hint: '一张图出完整设定板：主视觉 + 信息栏 + 三视图 + 四格表情',
        size: '1152x1536',
        text:
          '角色档案板排版：左侧三分之二为半身主视觉，右上为角色信息栏（姓名、年龄、身高、体重、性格、职业、风格），右中为正面、侧面、背面三视图，底部为四格表情特写（微笑、沉思、惊讶、冷淡），浅米色纸张背景，杂志排版，细分割线，中文标签清晰可读，所有画面为同一角色',
      },
    ]

    /* [value, label] pairs. gpt-image-2.6 accepts arbitrary sizes (verified:
       1152x1536 came back at exactly 1152x1536), so the list is a shortcut list,
       not a whitelist — the free-form field below accepts anything the model takes. */
    const SIZES = [
      ['1024x1024', '1:1 方图 · 1024'],
      ['1152x1536', '3:4 竖版 · 档案板'],
      ['1024x1536', '2:3 竖版 · 全身'],
      ['1024x1280', '4:5 半身'],
      ['1536x1024', '3:2 横版 · 三视图'],
      ['1536x864', '16:9 横版 · 场景'],
      ['864x1536', '9:16 竖屏'],
      ['auto', '自动（跟随提示词）'],
    ]
    const SIZE_VALUES = SIZES.map(function (pair) {
      return pair[0]
    })
    const QUALITIES = [
      ['low', '低（快、便宜）'],
      ['medium', '中'],
      ['high', '高（推荐，慢）'],
    ]
    const BACKGROUNDS = [
      ['auto', '自动'],
      ['opaque', '不透明'],
      ['transparent', '透明'],
    ]

    let state = {
      booted: false,
      loading: true,
      error: null,
      notice: null,
      settings: null,
      configured: false,
      hasKey: false,
      keyTail: '',
      prompt: '',
      refs: [],
      busy: false,
      elapsed: 0,
      results: [],
      gallery: [],
      galleryDir: '',
      settingsOpen: false,
      testing: false,
      saving: false,
      savingError: null,
      lightbox: null,
      form: { size: '1024x1024', quality: 'high', n: 1, background: 'auto', model: 'gpt-image-1' },
      draft: { provider: 'openai', baseUrl: '', apiKey: '', model: '', outputDir: '' },
      models: [],
      modelsLoading: false,
      modelsError: null,
      pickerOpen: false,
      pickerFilter: '',
    }

    const listeners = new Set()

    function subscribe(listener) {
      listeners.add(listener)
      return function unsubscribe() {
        listeners.delete(listener)
      }
    }

    function snapshot() {
      return state
    }

    function set(patch) {
      state = Object.assign({}, state, typeof patch === 'function' ? patch(state) : patch)
      for (const listener of listeners) listener()
    }

    function useStore() {
      if (typeof useSyncExternalStore === 'function') return useSyncExternalStore(subscribe, snapshot, snapshot)
      const pair = React.useState(0)
      const bump = pair[1]
      useEffect(function () {
        const listener = function () {
          bump(function (value) {
            return value + 1
          })
        }
        return subscribe(listener)
      }, [])
      return state
    }

    /* -------------------------------------------------------------------- net */

    function messageOf(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    async function request(path, init) {
      const response = await fetch(ROUTE + path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && (payload.error || payload.message)) || 'HTTP ' + response.status)
      return payload || {}
    }

    function postJson(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    /* ---------------------------------------------------------------- actions */

    function applyPayload(payload) {
      const settings = {
        provider: payload.provider || 'openai',
        baseUrl: payload.baseUrl || '',
        model: payload.model || 'gpt-image-1',
        outputDir: payload.outputDir || '',
        size: payload.size || '1024x1024',
        quality: payload.quality || 'high',
        background: payload.background || 'auto',
      }
      set(function (current) {
        return {
          booted: true,
          loading: false,
          settings: settings,
          configured: !!payload.configured,
          hasKey: !!payload.hasKey,
          keyTail: payload.keyTail || '',
          gallery: payload.gallery || current.gallery,
          galleryDir: payload.galleryDir || current.galleryDir,
          form: Object.assign({}, current.form, { model: settings.model, size: settings.size, quality: settings.quality, background: settings.background }),
          settingsOpen: current.booted ? current.settingsOpen : !payload.configured,
          draft: {
            provider: settings.provider,
            baseUrl: settings.baseUrl,
            apiKey: '',
            model: settings.model,
            outputDir: settings.outputDir,
          },
        }
      })
    }

    async function boot() {
      try {
        const payload = await request('/state')
        applyPayload(payload)
        loadModels()
      } catch (error) {
        set({ booted: true, loading: false, error: '面板没连上本地服务：' + messageOf(error) })
      }
    }

    /* The catalogue is a convenience, not a requirement: every field stays
       free-text so a model the relay does not advertise still works. */
    async function loadModels() {
      if (state.modelsLoading) return
      set({ modelsLoading: true, modelsError: null })
      try {
        const payload = await request('/models')
        if (payload.ok === false) throw new Error(payload.error || '拉取模型失败')
        set({
          models: Array.isArray(payload.models) ? payload.models : [],
          modelsLoading: false,
          modelsError: payload.message || null,
        })
      } catch (error) {
        set({ modelsLoading: false, modelsError: messageOf(error) })
      }
    }

    /* Native datalists filter against whatever is already in the box, which makes
       them useless for browsing once a model is selected. The picker is the
       explicit "show me everything" path. */
    const BUILTIN_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3']

    function modelCatalog() {
      const all = BUILTIN_MODELS.slice()
      for (const id of state.models || []) if (all.indexOf(id) < 0) all.push(id)
      return all
    }

    function openPicker() {
      set({ pickerOpen: true, pickerFilter: '' })
      loadModels()
    }

    function closePicker() {
      set({ pickerOpen: false, pickerFilter: '' })
    }

    function chooseModel(id) {
      set({ form: Object.assign({}, state.form, { model: id }), pickerOpen: false, pickerFilter: '' })
    }

    async function refreshGallery() {
      try {
        const payload = await request('/gallery')
        set({ gallery: payload.items || [], galleryDir: payload.dir || state.galleryDir })
      } catch (error) {
        /* gallery is best-effort */
      }
    }

    async function saveSettings() {
      const draft = state.draft
      set({ saving: true, savingError: null, error: null })
      try {
        const body = {
          provider: draft.provider || 'openai',
          baseUrl: draft.baseUrl,
          model: draft.model,
          outputDir: draft.outputDir,
        }
        if (draft.apiKey) body.apiKey = draft.apiKey
        const payload = await postJson('/settings', body)
        applyPayload(Object.assign({ gallery: state.gallery, galleryDir: state.galleryDir }, payload.settings))
        set({ saving: false, settingsOpen: false, notice: '设置已保存', draft: Object.assign({}, state.draft, { apiKey: '' }) })
        loadModels()
      } catch (error) {
        set({ saving: false, savingError: messageOf(error) })
      }
    }

    async function testConnection() {
      const draft = state.draft
      set({ testing: true, error: null, notice: null })
      try {
        const body = { provider: draft.provider || 'openai' }
        if (draft.baseUrl) body.baseUrl = draft.baseUrl
        if (draft.model) body.model = draft.model
        if (draft.apiKey) body.apiKey = draft.apiKey
        if (Object.keys(body).length) await postJson('/settings', body)
        const payload = await postJson('/test', {})
        if (payload.ok) set({ testing: false, notice: payload.message || '连接成功' })
        else set({ testing: false, error: payload.error || '连接失败' })
      } catch (error) {
        set({ testing: false, error: messageOf(error) })
      }
    }

    /* A channel preset only pre-fills the three fields that differ between the
       OpenAI-compatible dialect and Ark's Seedream, so the user can still edit
       every value afterwards (self-hosted relays, custom model ids). */
    function applyPreset(kind) {
      const preset =
        kind === 'ark'
          ? {
              provider: 'ark',
              baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
              model: 'doubao-seedream-4-0-250828',
            }
          : {
              provider: 'openai',
              baseUrl: 'https://api.gpt.ge/v1',
              model: 'gpt-image-2.6-flare',
            }
      set({ draft: Object.assign({}, state.draft, preset), savingError: null })
    }

    function readFileAsDataUrl(file) {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader()
        reader.onload = function () {
          resolve(String(reader.result || ''))
        }
        reader.onerror = function () {
          reject(new Error('读取图片失败：' + file.name))
        }
        reader.readAsDataURL(file)
      })
    }

    async function addRefs(fileList) {
      const files = Array.prototype.slice.call(fileList || [])
      if (!files.length) return
      const room = 6 - state.refs.length
      if (room <= 0) {
        set({ error: '参考图最多 6 张' })
        return
      }
      const accepted = []
      for (const file of files.slice(0, room)) {
        if (!/^image\//.test(file.type)) continue
        if (file.size > 12 * 1024 * 1024) {
          set({ error: file.name + ' 超过 12MB' })
          continue
        }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          accepted.push({ id: Math.random().toString(36).slice(2), name: file.name, dataUrl: dataUrl, bytes: file.size })
        } catch (error) {
          set({ error: messageOf(error) })
        }
      }
      if (accepted.length) set({ refs: state.refs.concat(accepted), error: null })
    }

    function removeRef(id) {
      set({ refs: state.refs.filter(function (ref) {
        return ref.id !== id
      }) })
    }

    async function generateNow() {
      if (state.busy) return
      if (!state.configured) {
        set({ settingsOpen: true, error: '先填 API Key：右上角「设置」' })
        return
      }
      const prompt = String(state.prompt || '').trim()
      if (!prompt) {
        set({ error: '先写提示词，或点上面的模板' })
        return
      }
      set({ busy: true, error: null, notice: null, elapsed: 0, results: [] })
      try {
        const wanted = String(state.form.size || '').trim()
        const size = /^\d{3,4}x\d{3,4}$/.test(wanted) || wanted === 'auto' ? wanted : 'auto'
        const payload = await postJson('/generate', {
          prompt: prompt,
          size: size,
          quality: state.form.quality,
          n: state.form.n,
          background: state.form.background,
          model: state.form.model,
          refs: state.refs.map(function (ref) {
            return { name: ref.name, dataUrl: ref.dataUrl }
          }),
        })
        if (payload.ok === false) throw new Error(payload.error || '生成失败')
        const images = payload.images || []
        set({ busy: false, results: images, notice: '已保存 ' + images.length + ' 张到 ' + payload.dir })
        refreshGallery()
      } catch (error) {
        set({ busy: false, error: messageOf(error) })
      }
    }

    async function reveal() {
      try {
        const payload = await postJson('/reveal', {})
        if (payload.ok === false) throw new Error(payload.error || '打不开文件夹')
        set({ notice: payload.dir })
      } catch (error) {
        set({ error: messageOf(error) })
      }
    }

    function useElapsed(busy) {
      useEffect(
        function () {
          if (!busy) return undefined
          const started = Date.now()
          const timer = window.setInterval(function () {
            set({ elapsed: Math.round((Date.now() - started) / 1000) })
          }, 1000)
          return function () {
            window.clearInterval(timer)
          }
        },
        [busy],
      )
    }

    /* --------------------------------------------------------------- fragments */

    function Section(props) {
      return h(
        'section',
        { className: 'ig-section' + (props.tight ? ' is-tight' : '') },
        props.title
          ? h(
              'div',
              { className: 'ig-section-head' },
              h('span', { className: 'ig-section-title' }, props.title),
              props.aside ? h('span', { className: 'ig-section-aside' }, props.aside) : null,
            )
          : null,
        props.children,
      )
    }

    function ResultCard(props) {
      const image = props.image
      return h(
        'figure',
        { className: 'ig-card' },
        h('button', {
          type: 'button',
          className: 'ig-card-image',
          title: '点开看大图',
          onClick: function () {
            set({ lightbox: image })
          },
        }, h('img', { src: image.url, alt: image.name, loading: 'lazy' })),
        h(
          'figcaption',
          { className: 'ig-card-meta' },
          h('span', { className: 'ig-card-name', title: image.path }, image.name),
          h(
            'span',
            { className: 'ig-card-actions' },
            h(
              'a',
              { className: 'ig-link', href: image.url, download: image.name },
              '下载',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ig-link',
                onClick: function () {
                  if (navigator.clipboard && image.path) navigator.clipboard.writeText(image.path).then(
                    function () {
                      set({ notice: '已复制路径' })
                    },
                    function () {
                      set({ notice: image.path })
                    },
                  )
                },
              },
              '复制路径',
            ),
          ),
        ),
      )
    }

    /* --------------------------------------------------------------- the panel */

    function ImageGenPanel() {
      const current = useStore()
      useElapsed(current.busy)

      useEffect(function () {
        if (!state.booted) boot()
      }, [])

      useEffect(
        function () {
          if (!current.notice) return undefined
          const timer = window.setTimeout(function () {
            set({ notice: null })
          }, 5000)
          return function () {
            window.clearTimeout(timer)
          }
        },
        [current.notice],
      )

      const fileInput = useRef(null)

      function pickRefs() {
        if (fileInput.current) fileInput.current.click()
      }

      const header = h(
        'div',
        { className: 'ig-header' },
        h(
          'div',
          { className: 'ig-brand' },
          h('span', { className: 'ig-brand-dot' }),
          h('span', null, 'AI 生图'),
          current.configured ? h('span', { className: 'ig-brand-sub' }, current.settings && current.settings.model) : null,
        ),
        h(
          'div',
          { className: 'ig-actions' },
          current.notice ? h('span', { className: 'ig-notice' }, current.notice) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'ig-btn',
              title: '在文件资源管理器中打开输出目录',
              onClick: reveal,
            },
            '打开文件夹',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ig-btn' + (current.settingsOpen ? ' is-active' : ''),
              onClick: function () {
                set({ settingsOpen: !state.settingsOpen, savingError: null })
              },
            },
            '设置',
          ),
        ),
      )

      const settingsPanel = current.settingsOpen
        ? h(
            Section,
            { title: '连接设置', aside: 'Key 只存在本机，不写进页面' },
            h(
              'div',
              { className: 'ig-form' },
              h(
                'div',
                { className: 'ig-presets' },
                h('span', { className: 'ig-field-label' }, '通道'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ig-chip' + (current.draft.provider === 'openai' ? ' is-on' : ''),
                    onClick: function () {
                      applyPreset('openai')
                    },
                  },
                  'OpenAI 兼容（中转）',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ig-chip' + (current.draft.provider === 'ark' ? ' is-on' : ''),
                    onClick: function () {
                      applyPreset('ark')
                    },
                  },
                  '火山方舟 Seedream',
                ),
              ),
              h(
                'label',
                { className: 'ig-field' },
                h('span', { className: 'ig-field-label' }, 'Base URL'),
                h('input', {
                  className: 'ig-input',
                  value: current.draft.baseUrl,
                  placeholder: 'https://api.openai.com/v1',
                  onChange: function (event) {
                    set({ draft: Object.assign({}, state.draft, { baseUrl: event.target.value }) })
                  },
                }),
                h(
                  'span',
                  { className: 'ig-hint' },
                  '直连写 https://api.openai.com/v1；被墙就换中转站地址（一般也是 …/v1）。',
                ),
              ),
              h(
                'label',
                { className: 'ig-field' },
                h('span', { className: 'ig-field-label' }, 'API Key'),
                h('input', {
                  className: 'ig-input',
                  type: 'password',
                  autoComplete: 'off',
                  value: current.draft.apiKey,
                  placeholder: current.hasKey ? '已保存 ····' + current.keyTail + '（留空不修改）' : 'sk-…',
                  onChange: function (event) {
                    set({ draft: Object.assign({}, state.draft, { apiKey: event.target.value }) })
                  },
                }),
              ),
              h(
                'div',
                { className: 'ig-field-row' },
                h(
                  'label',
                  { className: 'ig-field' },
                  h('span', { className: 'ig-field-label' }, '默认模型'),
                  h('input', {
                    className: 'ig-input',
                    list: 'ig-model-options',
                    value: current.draft.model,
                    placeholder: 'gpt-image-2.6-flare',
                    onChange: function (event) {
                      set({ draft: Object.assign({}, state.draft, { model: event.target.value }) })
                    },
                  }),
                  h(
                    'span',
                    { className: 'ig-hint' },
                    current.modelsLoading
                      ? '正在拉取模型列表…'
                      : current.models.length
                        ? '已加载 ' + current.models.length + ' 个型号，可直接输入任意 id'
                        : current.modelsError || '可手填任意模型 id',
                  ),
                ),
                h(
                  'label',
                  { className: 'ig-field is-grow' },
                  h('span', { className: 'ig-field-label' }, '保存目录'),
                  h('input', {
                    className: 'ig-input',
                    value: current.draft.outputDir,
                    placeholder: 'C:\\Users\\…\\人物资产',
                    onChange: function (event) {
                      set({ draft: Object.assign({}, state.draft, { outputDir: event.target.value }) })
                    },
                  }),
                ),
              ),
              current.savingError ? h('div', { className: 'ig-error' }, current.savingError) : null,
              h(
                'div',
                { className: 'ig-form-actions' },
                h(
                  'button',
                  { type: 'button', className: 'ig-btn', disabled: current.testing, onClick: testConnection },
                  current.testing ? '测试中…' : '测试连接',
                ),
                h(
                  'button',
                  { type: 'button', className: 'ig-btn is-primary', disabled: current.saving, onClick: saveSettings },
                  current.saving ? '保存中…' : '保存',
                ),
              ),
            ),
          )
        : null

      const composer = h(
        Section,
        { title: '提示词', aside: '中文可用；写清构图、背景、光线' },
        h('textarea', {
          className: 'ig-textarea',
          rows: 5,
          value: current.prompt,
          placeholder: '例：年轻剑客，黑色长发束起，玄色劲装，正面全身站姿，纯白背景，全身入画，写实国风，细节清晰',
          onChange: function (event) {
            set({ prompt: event.target.value })
          },
        }),
        h(
          'div',
          { className: 'ig-chips' },
          PRESETS.map(function (preset) {
            return h(
              'button',
              {
                type: 'button',
                key: preset.key,
                className: 'ig-chip',
                title: preset.hint || '',
                onClick: function () {
                  const text = String(state.prompt || '').trim()
                  const patch = {}
                  if (preset.size) {
                    patch.form = Object.assign({}, state.form, { size: preset.size })
                  }
                  if (!text) {
                    patch.prompt = preset.text
                    set(patch)
                    return undefined
                  }
                  if (text.indexOf(preset.text) >= 0) {
                    if (patch.form) set(patch)
                    return undefined
                  }
                  patch.prompt = text.replace(/[，,]\s*$/, '') + '，' + preset.text
                  set(patch)
                  return undefined
                },
              },
              preset.label,
            )
          }),
        ),
        h(
          'div',
          { className: 'ig-refs' },
          h(
            'div',
            { className: 'ig-refs-head' },
            h('span', { className: 'ig-field-label' }, '参考图' + (current.refs.length ? ' · ' + current.refs.length : '')),
            h(
              'span',
              { className: 'ig-hint' },
              '先出正面全身锚点，再拿它当参考图派生其它视图，人物才不跑形。',
            ),
          ),
          h(
            'div',
            { className: 'ig-thumbs' },
            current.refs.map(function (ref) {
              return h(
                'div',
                { className: 'ig-thumb', key: ref.id, title: ref.name },
                h('img', { src: ref.dataUrl, alt: ref.name }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ig-thumb-x',
                    title: '移除',
                    onClick: function () {
                      removeRef(ref.id)
                    },
                  },
                  '×',
                ),
              )
            }),
            h(
              'button',
              { type: 'button', className: 'ig-thumb-add', onClick: pickRefs },
              h('span', null, '+'),
              h('span', { className: 'ig-thumb-add-label' }, '参考图'),
            ),
          ),
          h('input', {
            ref: fileInput,
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp',
            multiple: true,
            style: { display: 'none' },
            onChange: function (event) {
              addRefs(event.target.files)
              event.target.value = ''
            },
          }),
        ),
      )

      const controls = h(
        Section,
        { title: '参数', tight: true },
        h(
          'div',
          { className: 'ig-controls' },
          h(
            'label',
            { className: 'ig-control is-wide' },
            h('span', null, '尺寸'),
            h(
              'div',
              { className: 'ig-size-row' },
              h(
                'select',
                {
                  className: 'ig-select',
                  value: SIZE_VALUES.indexOf(current.form.size) >= 0 ? current.form.size : 'custom',
                  onChange: function (event) {
                    const value = event.target.value
                    if (value === 'custom') return
                    set({ form: Object.assign({}, state.form, { size: value }) })
                  },
                },
                SIZES.map(function (pair) {
                  return h('option', { key: pair[0], value: pair[0] }, pair[1])
                }),
                h('option', { key: 'custom', value: 'custom' }, '自定义…'),
              ),
              h('input', {
                className: 'ig-input ig-size-input',
                value: current.form.size,
                placeholder: '宽x高，如 1152x1536',
                spellCheck: false,
                onChange: function (event) {
                  set({ form: Object.assign({}, state.form, { size: event.target.value.trim() }) })
                },
              }),
            ),
          ),
          h(
            'label',
            { className: 'ig-control' },
            h('span', null, '质量'),
            h(
              'select',
              {
                className: 'ig-select',
                value: current.form.quality,
                onChange: function (event) {
                  set({ form: Object.assign({}, state.form, { quality: event.target.value }) })
                },
              },
              QUALITIES.map(function (pair) {
                return h('option', { key: pair[0], value: pair[0] }, pair[1])
              }),
            ),
          ),
          h(
            'label',
            { className: 'ig-control' },
            h('span', null, '数量'),
            h(
              'select',
              {
                className: 'ig-select',
                value: String(current.form.n),
                onChange: function (event) {
                  set({ form: Object.assign({}, state.form, { n: Number(event.target.value) }) })
                },
              },
              [1, 2, 3, 4].map(function (count) {
                return h('option', { key: count, value: String(count) }, String(count))
              }),
            ),
          ),
          h(
            'label',
            { className: 'ig-control' },
            h('span', null, '背景'),
            h(
              'select',
              {
                className: 'ig-select',
                value: current.form.background,
                onChange: function (event) {
                  set({ form: Object.assign({}, state.form, { background: event.target.value }) })
                },
              },
              BACKGROUNDS.map(function (pair) {
                return h('option', { key: pair[0], value: pair[0] }, pair[1])
              }),
            ),
          ),
          h(
            'label',
            { className: 'ig-control is-wide' },
            h('span', null, '模型'),
            h(
              'div',
              { className: 'ig-model-row' },
              h('input', {
                className: 'ig-input',
                list: 'ig-model-options',
                value: current.form.model,
                placeholder: 'gpt-image-2.6-flare',
                onChange: function (event) {
                  set({ form: Object.assign({}, state.form, { model: event.target.value }) })
                },
              }),
              h('button', { type: 'button', className: 'ig-btn is-tiny', onClick: openPicker }, '全部'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ig-run' },
          h(
            'button',
            {
              type: 'button',
              className: 'ig-btn is-primary is-large',
              disabled: current.busy,
              onClick: generateNow,
            },
            current.busy
              ? h(
                  'span',
                  { className: 'ig-running' },
                  h('span', { className: 'ig-spinner' }),
                  '生成中… ' + current.elapsed + 's',
                )
              : '生成图片',
          ),
          current.busy
            ? h('span', { className: 'ig-hint' }, 'gpt-image-1 高质量通常 30–120 秒，别关页面。')
            : h('span', { className: 'ig-hint' }, '结果会直接存进上面的目录，文件名带时间戳。'),
        ),
      )

      const results = current.results.length
        ? h(
            Section,
            { title: '本次结果', aside: current.results.length + ' 张' },
            h(
              'div',
              { className: 'ig-grid' },
              current.results.map(function (image) {
                return h(ResultCard, { key: image.name, image: image })
              }),
            ),
          )
        : null

      const gallery = current.gallery.length
        ? h(
            Section,
            { title: '最近生成', aside: current.galleryDir },
            h(
              'div',
              { className: 'ig-grid is-dense' },
              current.gallery.map(function (image) {
                return h(ResultCard, { key: image.name, image: image })
              }),
            ),
          )
        : null

      const empty = h(
        'div',
        { className: 'ig-empty' },
        h('div', { className: 'ig-empty-title' }, current.busy ? '正在出图…' : '还没有图片'),
        h(
          'div',
          { className: 'ig-empty-text' },
          current.busy
            ? '请求已经发出去，等接口返回。第一次调通常慢一些。'
            : '写一句提示词，或点一个模板，然后按「生成图片」。',
        ),
      )

      return h(
        'div',
        { className: 'ig-root' },
        h('style', null, CSS),
        h(
          'datalist',
          { id: 'ig-model-options' },
          (function () {
            const builtin = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3']
            const all = builtin.slice()
            for (const id of current.models || []) if (all.indexOf(id) < 0) all.push(id)
            return all.map(function (id) {
              return h('option', { key: id, value: id })
            })
          })(),
        ),
        header,
        current.error
          ? h(
              'div',
              { className: 'ig-banner is-error' },
              h('span', null, current.error),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ig-banner-x',
                  onClick: function () {
                    set({ error: null })
                  },
                },
                '×',
              ),
            )
          : null,
        !current.configured && current.booted
          ? h(
              'div',
              { className: 'ig-banner is-warn' },
              '还没配置 API Key。填入 Base URL 和 Key 后保存，就能开始生图。',
            )
          : null,
        h(
          'div',
          { className: 'ig-page' },
          settingsPanel,
          composer,
          controls,
          results,
          gallery,
          !current.loading && !current.results.length && !current.gallery.length && !current.busy ? empty : null,
        ),
        current.pickerOpen
          ? h(
              'div',
              {
                className: 'ig-modal-mask',
                onClick: function () {
                  closePicker()
                },
              },
              h(
                'div',
                {
                  className: 'ig-modal',
                  onClick: function (event) {
                    event.stopPropagation()
                  },
                },
                h(
                  'div',
                  { className: 'ig-modal-head' },
                  h('span', null, '选择模型' + (current.models.length ? ' · ' + current.models.length + ' 个' : '')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ig-btn is-tiny',
                      onClick: function () {
                        loadModels()
                      },
                    },
                    current.modelsLoading ? '刷新中…' : '刷新',
                  ),
                  h('button', { type: 'button', className: 'ig-btn is-tiny', onClick: closePicker }, '关闭'),
                ),
                h('input', {
                  className: 'ig-input',
                  placeholder: '搜索型号…',
                  autoFocus: true,
                  value: current.pickerFilter,
                  onChange: function (event) {
                    set({ pickerFilter: event.target.value })
                  },
                }),
                h(
                  'div',
                  { className: 'ig-modal-list' },
                  (function () {
                    const filter = String(current.pickerFilter || '').trim().toLowerCase()
                    const ids = modelCatalog().filter(function (id) {
                      return !filter || id.toLowerCase().indexOf(filter) >= 0
                    })
                    if (!ids.length) {
                      return h('div', { className: 'ig-hint' }, current.modelsError || '没有匹配的型号，可直接手填。')
                    }
                    return ids.map(function (id) {
                      return h(
                        'button',
                        {
                          key: id,
                          type: 'button',
                          className: 'ig-model-item' + (id === current.form.model ? ' is-on' : ''),
                          onClick: function () {
                            chooseModel(id)
                          },
                        },
                        id,
                      )
                    })
                  })(),
                ),
              ),
            )
          : null,
        current.lightbox
          ? h(
              'div',
              {
                className: 'ig-lightbox',
                onClick: function () {
                  set({ lightbox: null })
                },
              },
              h('img', { src: current.lightbox.url, alt: current.lightbox.name }),
              h(
                'div',
                { className: 'ig-lightbox-bar' },
                h('span', { className: 'ig-lightbox-name' }, current.lightbox.name),
                h(
                  'a',
                  { className: 'ig-btn is-primary', href: current.lightbox.url, download: current.lightbox.name },
                  '下载',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ig-btn',
                    onClick: function () {
                      set({ lightbox: null })
                    },
                  },
                  '关闭',
                ),
              ),
            )
          : null,
      )
    }

    /* -------------------------------------------------------------------- CSS */

    const CSS = [
      '.ig-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
      '.ig-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;background:var(--dsw-alias-bg-layer-1)}',
      '.ig-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;min-width:0}',
      '.ig-brand-dot{width:9px;height:9px;border-radius:3px;background:linear-gradient(135deg,#f0abfc,#818cf8);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.ig-brand-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
      '.ig-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.ig-notice{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ig-page{flex:1;min-height:0;overflow:auto;padding:14px 16px 32px;display:flex;flex-direction:column;gap:14px}',
      '.ig-section{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px 14px}',
      '.ig-section.is-tight{gap:8px}',
      '.ig-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.ig-section-title{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}',
      '.ig-section-aside{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}',
      '.ig-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:96px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;padding:10px 12px;outline:none}',
      '.ig-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ig-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.ig-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font:inherit;font-size:11px;cursor:pointer}',
      '.ig-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.ig-refs{display:flex;flex-direction:column;gap:8px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:10px}',
      '.ig-refs-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.ig-thumbs{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.ig-thumb{position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.ig-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
      '.ig-thumb-x{position:absolute;top:2px;right:2px;width:18px;height:18px;line-height:16px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:13px;cursor:pointer;padding:0}',
      '.ig-thumb-add{width:64px;height:64px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:pointer;font:inherit}',
      '.ig-thumb-add span:first-child{font-size:16px;line-height:1}',
      '.ig-thumb-add-label{font-size:10px}',
      '.ig-thumb-add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.ig-controls{display:flex;flex-wrap:wrap;gap:10px}',
      '.ig-control{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ig-control.is-wide{min-width:150px;flex:1}',
      '.ig-select,.ig-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 8px;font:inherit;font-size:12px;outline:none}',
      '.ig-input{width:100%;padding:7px 10px}',
      '.ig-select:focus,.ig-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ig-run{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px}',
      '.ig-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}',
'.ig-btn.is-tiny{padding:2px 8px;font-size:11px}',
'.ig-model-row{display:flex;gap:6px;align-items:center;min-width:0}',
'.ig-model-row .ig-input{flex:1;min-width:0}',
'.ig-size-row{display:flex;gap:6px;align-items:center;min-width:0}',
'.ig-size-row .ig-select{flex:1;min-width:0}',
'.ig-size-input{width:132px!important;flex:none;padding:5px 8px!important}',
'.ig-modal-mask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}',
'.ig-modal{width:min(560px,86vw);max-height:72vh;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;box-shadow:0 18px 48px rgba(0,0,0,.28)}',
'.ig-modal-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
'.ig-modal-head > span:first-child{flex:1;font-weight:600;color:var(--dsw-alias-label-primary)}',
'.ig-modal-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}',
'.ig-model-item{text-align:left;background:none;border:0;border-radius:6px;padding:5px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}',
'.ig-model-item:hover{background:var(--dsw-alias-bg-layer-2)}',
'.ig-model-item.is-on{background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.ig-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.ig-btn.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.ig-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.ig-btn.is-primary:hover:not(:disabled){filter:brightness(1.06)}',
      '.ig-btn.is-large{padding:8px 22px;font-size:13px;font-weight:600}',
      '.ig-btn:disabled{opacity:.6;cursor:default}',
      '.ig-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.ig-error{font-size:12px;color:#f87171;white-space:pre-wrap}',
      '.ig-banner{display:flex;align-items:flex-start;gap:10px;padding:8px 16px;font-size:12px;flex:0 0 auto}',
      '.ig-banner.is-error{background:color-mix(in srgb,#f87171 14%,transparent);color:#fca5a5}',
      '.ig-banner.is-warn{background:color-mix(in srgb,#fbbf24 12%,transparent);color:#fcd34d}',
      '.ig-banner span{flex:1;min-width:0}',
      '.ig-banner-x{border:0;background:transparent;color:inherit;font-size:15px;line-height:1;cursor:pointer;padding:0 2px}',
      '.ig-form{display:flex;flex-direction:column;gap:10px}',
      '.ig-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.ig-field.is-grow{flex:1}',
      '.ig-field-row{display:flex;gap:10px;flex-wrap:wrap}',
      '.ig-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.ig-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;font-family:inherit}',
      '.ig-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.ig-chip.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.ig-field-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ig-form-actions{display:flex;gap:8px;justify-content:flex-end}',
      '.ig-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}',
      '.ig-grid.is-dense{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}',
      '.ig-card{margin:0;display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.ig-card-image{padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);cursor:zoom-in;display:block;aspect-ratio:1/1}',
      '.ig-card-image img{width:100%;height:100%;object-fit:cover;display:block}',
      '.ig-card-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.ig-card-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.ig-card-actions{display:flex;gap:6px;flex:0 0 auto}',
      '.ig-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:10px;padding:0;cursor:pointer;text-decoration:none}',
      '.ig-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:42px 12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.ig-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ig-empty-text{font-size:11px;max-width:320px}',
      '.ig-running{display:inline-flex;align-items:center;gap:8px}',
      '.ig-spinner{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:ig-spin .8s linear infinite}',
      '@keyframes ig-spin{to{transform:rotate(360deg)}}',
      '.ig-lightbox{position:fixed;inset:0;z-index:60;background:rgba(8,10,14,.86);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;cursor:zoom-out}',
      '.ig-lightbox img{max-width:min(92vw,1100px);max-height:78vh;object-fit:contain;border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.5)}',
      '.ig-lightbox-bar{display:flex;align-items:center;gap:10px;cursor:default;flex-wrap:wrap;justify-content:center}',
      '.ig-lightbox-name{font-size:11px;color:#cbd5e1;max-width:50vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'imagegen',
              order: 30,
              label: function () {
                return 'AI 生图'
              },
            },
            ImageGenIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'imagegen' }, ImageGenPanel)
        })
      },
    }

    function ImageGenIcon(props) {
      const size = (props && props.size) || 18
      const active = !!(props && props.active)
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 3 }),
        h('circle', { cx: 8.6, cy: 9.8, r: 1.7 }),
        h('path', { d: 'M3.8 17.4l4.7-5.2a1.7 1.7 0 0 1 2.5 0l3.1 3.4 2.1-2.3a1.7 1.7 0 0 1 2.5 0l2.4 2.6' }),
      )
    }
  },
})
