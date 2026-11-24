ObjC.import('AppKit');
ObjC.import('Foundation');
ObjC.import('ApplicationServices');
ObjC.import('objc');

// Native AppKit UI, packaged with macOS's JavaScript for Automation runtime.
var ui = {}, controller, prefs = {}, currentTitle = '', currentPath = '';
var base = ObjC.unwrap($.NSHomeDirectory()) + '/Library/Application Support/MoyuReader';
var fm = $.NSFileManager.defaultManager;
var testing = false;
var globalKeyMonitor = null, globalKeyHandler = null;
var shortcutReady = false;
var chaptersEnabled = false, chapters = [];
var searchState = { query: '', range: null };
var shortcutTestSink = null;

function recognizeChapters(text) {
    // Only stand-alone, short heading lines; indices use UTF-16 like NSRange.
    var pattern = /^[ \t\u3000]*(?:第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9０-９]+[章回节卷部篇集][^\n]{0,100}|(?:chapter|part|book)[ \t]+(?:[0-9]+|[ivxlcdm]+)\b[^\n]{0,100}|(?:序章|楔子|序言|引子|前言|后记|尾声|终章|番外)[^\n]{0,60})[ \t\u3000]*$/gmi;
    var found = [], match;
    while ((match = pattern.exec(text)) !== null) {
        var title = match[0].trim();
        found.push({ title: title, index: match.index + match[0].indexOf(title), length: title.length });
    }
    return found;
}
function refreshChapters() {
    chapters = chaptersEnabled ? recognizeChapters(ObjC.unwrap(ui.text.string)) : [];
    ui.chapterToggle.title = chaptersEnabled ? '识别目录：开' : '识别目录：关';
    ui.chapterList.removeAllItems;
    ui.chapterList.addItemWithTitle(chaptersEnabled ? (chapters.length ? '已识别 ' + chapters.length + ' 章 · 选择跳转' : '未找到规范章节标题') : '手动开启后识别章节目录');
    for (var i = 0; i < chapters.length; i++)
        ui.chapterList.addItemWithTitle((i + 1) + '. ' + chapters[i].title);
    ui.chapterList.enabled = chaptersEnabled && chapters.length > 0;
}
function toggleChapters() { chaptersEnabled = !chaptersEnabled; refreshChapters(); }
function jumpToRange(range, focus) {
    ui.text.setSelectedRange($.NSMakeRange(range.index, range.length));
    ui.text.scrollRangeToVisible($.NSMakeRange(range.index, range.length));
    if (focus) ui.window.makeFirstResponder(ui.text);
    updateStatus(); save();
}
function selectChapter() {
    var index = Number(ui.chapterList.indexOfSelectedItem) - 1;
    if (index >= 0 && index < chapters.length) jumpToRange(chapters[index], true);
}
function locateText(text, query, start, direction) {
    if (!query.length || !text.length) return null;
    var nativeText = $(text), length = text.length;
    start = Math.max(0, Math.min(length, start));
    var options = $.NSCaseInsensitiveSearch | $.NSLiteralSearch | (direction < 0 ? $.NSBackwardsSearch : 0);
    var range = direction < 0 ? $.NSMakeRange(0, start) : $.NSMakeRange(start, length - start);
    var result = nativeText.rangeOfStringOptionsRange($(query), options, range);
    var wrapped = false;
    if (Number(result.location) > length) {
        wrapped = true;
        result = nativeText.rangeOfStringOptionsRange($(query), options, $.NSMakeRange(0, length));
    }
    if (Number(result.location) > length) return null;
    return { index: Number(result.location), length: Number(result.length), wrapped: wrapped };
}
function searchText(direction) {
    var query = ObjC.unwrap(ui.search.stringValue), text = ObjC.unwrap(ui.text.string);
    if (!query.length) {
        searchState = { query: '', range: null };
        ui.searchResult.stringValue = '输入关键词';
        return;
    }
    var same = query === searchState.query && searchState.range !== null;
    var start = same ? (direction < 0 ? searchState.range.index : searchState.range.index + searchState.range.length) : (direction < 0 ? text.length : 0);
    var match = locateText(text, query, start, direction);
    searchState = { query: query, range: match };
    if (match === null) {
        ui.searchResult.stringValue = '未找到';
        ui.text.setSelectedRange($.NSMakeRange(Number(ui.text.selectedRange.location), 0));
        return;
    }
    ui.searchResult.stringValue = match.wrapped ? '已循环定位' : '已定位';
    jumpToRange(match, false);
}
function focusSearch() {
    if (prefs.compact) toggleCompact();
    ui.window.makeFirstResponder(ui.search);
    ui.search.selectText(null);
}
function changeLineSpacing(value) {
    var position = progress();
    prefs.lineSpacing = Math.max(0, Math.min(40, Math.round(value)));
    applyStyle(); restoreProgress(position); save();
}

function shortcutAction(event) {
    var flags = Number(event.modifierFlags);
    if ((flags & (0x20000 | 0x40000 | 0x80000 | 0x100000)) !== 0x80000) return '';
    if (Number(event.keyCode) === 6) return 'visibility';
    if (Number(event.keyCode) === 7) return 'compact';
    return '';
}
function isToggleShortcut(event) {
    return shortcutAction(event) === 'visibility' && !Boolean(event.isARepeat);
}
function dispatchShortcut(event, perform) {
    var action = shortcutAction(event);
    if (!action) return false;
    if (!Boolean(event.isARepeat)) {
        if (!perform && testing && shortcutTestSink) perform = shortcutTestSink;
        if (perform) perform(action);
        else if (action === 'visibility') toggleReader();
        else toggleCompact();
    }
    return true;
}
function toggleCompact() {
    var p = progress();
    prefs.compact = !prefs.compact;
    layout();
    restoreProgress(p);
    save();
}
function toggleReader() {
    var app = $.NSApplication.sharedApplication;
    if (Boolean(ui.window.visible) && !Boolean(app.hidden) && !Boolean(ui.window.miniaturized)) {
        save();
        app.hide(null);
    } else {
        app.unhide(null);
        if (Boolean(ui.window.miniaturized)) ui.window.deminiaturize(null);
        ui.window.makeKeyAndOrderFront(null);
        app.activateIgnoringOtherApps(true);
        ui.window.makeFirstResponder(ui.text);
    }
}
function refreshShortcut() {
    if (testing) return;
    var trusted = Boolean($.AXIsProcessTrusted());
    if (!trusted && globalKeyMonitor !== null) {
        $.NSEvent.removeMonitor(globalKeyMonitor);
        globalKeyMonitor = null;
        globalKeyHandler = null;
    }
    if (trusted && globalKeyMonitor === null) {
        globalKeyHandler = function(event) { dispatchShortcut(event); };
        var monitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(1 << 10, globalKeyHandler);
        if (!monitor.isNil()) globalKeyMonitor = monitor;
    }
    shortcutReady = trusted && globalKeyMonitor !== null;
    ui.shortcut.title = shortcutReady ? '全局快捷键：开' : '启用全局快捷键';
}
function enableShortcut() {
    refreshShortcut();
    if (shortcutReady) {
        alert('全局快捷键\n\n⌥Z：隐藏 / 恢复\n⌥X：收起 / 展开\n\n阅读器需保持运行。');
        return;
    }
    var options = $.NSMutableDictionary.dictionary;
    options.setObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt'));
    $.AXIsProcessTrustedWithOptions(options);
    alert('阅读器内的 ⌥Z、⌥X 无需授权即可使用。\n\n若要在其他应用里使用，请在「系统设置 → 隐私与安全性 → 辅助功能」中允许当前版本的「摸鱼阅读」。\n\n升级后如仍无反应，请移除旧条目、重新添加当前应用，然后退出并重新打开。按钮显示「全局快捷键：开」表示监听已安装。');
    refreshShortcut();
}

function stringAt(path) {
    var s = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    return s.isNil() ? null : ObjC.unwrap(s);
}
function writeText(text, path) {
    if (!$(text).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null))
        throw new Error('无法保存文件：' + path);
}
function loadPrefs() {
    try { prefs = JSON.parse(stringAt(base + '/settings.json') || '{}'); } catch (_) { prefs = {}; }
    prefs.opacity = typeof prefs.opacity === 'number' ? Math.max(0, Math.min(1, prefs.opacity)) : 0.78;
    prefs.fontSize = Math.max(12, Math.min(32, Number(prefs.fontSize) || 18));
    prefs.lineSpacing = typeof prefs.lineSpacing === 'number' ? Math.max(0, Math.min(40, prefs.lineSpacing)) : Math.round(prefs.fontSize * 0.5);
    prefs.dark = prefs.dark !== false;
    prefs.pinned = prefs.pinned !== false;
    prefs.progress = prefs.progress || {};
}
function progress() {
    var height = Number(ui.text.frame.size.height) - Number(ui.scroll.contentView.bounds.size.height);
    return height > 0 ? Math.max(0, Math.min(1, Number(ui.scroll.contentView.bounds.origin.y) / height)) : 0;
}
function save() {
    if (testing || !ui.text) return;
    if (currentPath) prefs.progress[currentPath] = progress();
    prefs.lastTitle = currentTitle;
    prefs.lastPath = currentPath;
    try { writeText(JSON.stringify(prefs), base + '/settings.json'); } catch (_) {}
    updateStatus();
}
function restoreProgress(value) {
    ui.text.layoutManager.ensureLayoutForTextContainer(ui.text.textContainer);
    var height = Math.max(0, Number(ui.text.frame.size.height) - Number(ui.scroll.contentView.bounds.size.height));
    ui.scroll.contentView.scrollToPoint($.NSMakePoint(0, height * Math.max(0, Math.min(1, value || 0))));
    ui.scroll.reflectScrolledClipView(ui.scroll.contentView);
}
function updateStatus() {
    var title = currentTitle ? currentTitle + '  ·  ' + Math.round(progress() * 100) + '%' : 'TXT 本地阅读';
    ui.status.stringValue = title + (shortcutReady ? '  ·  ⌥Z 隐藏 · ⌥X 收起' : '  ·  ⌥Z / ⌥X · 全局待授权');
}
function alert(message) {
    var box = $.NSAlert.alloc.init;
    box.messageText = '摸鱼阅读';
    box.informativeText = message;
    box.addButtonWithTitle('知道了');
    box.runModal;
}
function decode(data) {
    // BOM-aware Unicode first, then strict UTF-8 and common Chinese encodings.
    var bytes = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    var encodings = bytes.indexOf('//4') === 0 || bytes.indexOf('/v8') === 0 ? [$.NSUTF16StringEncoding] : [];
    encodings.push($.NSUTF8StringEncoding, 0x80000632); // CF GB18030 -> NSStringEncoding
    for (var i = 0; i < encodings.length; i++) {
        var decoded = $.NSString.alloc.initWithDataEncoding(data, encodings[i]);
        if (!decoded.isNil()) return ObjC.unwrap(decoded).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    }
    throw new Error('无法识别文本编码，请先将 TXT 转换为 UTF-8。');
}
function showBook(text, title, path, position) {
    ui.text.string = text;
    currentTitle = title;
    currentPath = path;
    ui.heading.stringValue = '摸鱼阅读';
    // Each book starts with recognition off; opening a file never scans implicitly.
    chaptersEnabled = false;
    refreshChapters();
    searchState = { query: '', range: null };
    ui.search.stringValue = '';
    ui.searchResult.stringValue = '输入关键词';
    applyStyle();
    restoreProgress(position);
    updateStatus();
}
function importBook() {
    var panel = $.NSOpenPanel.openPanel;
    panel.title = '选择一本 TXT 小说';
    panel.canChooseDirectories = false;
    panel.allowsMultipleSelection = false;
    panel.allowedFileTypes = ['txt'];
    if (Number(panel.runModal) !== 1) return;
    var path = ObjC.unwrap(panel.URL.path);
    try {
        var attrs = fm.attributesOfItemAtPathError($(path), null);
        if (Number(attrs.objectForKey($.NSFileSize)) > 30 * 1024 * 1024)
            throw new Error('请导入 30 MB 以内的 TXT 文件。');
        var data = $.NSData.dataWithContentsOfFile($(path));
        if (data.isNil()) throw new Error('无法读取这个文件。');
        var text = decode(data);
        save();
        // Cache before changing the screen, so failed imports preserve the current book.
        writeText(text, base + '/current.txt');
        var title = ObjC.unwrap($(path).lastPathComponent.stringByDeletingPathExtension);
        showBook(text, title, path, prefs.progress[path] || 0);
        save();
    } catch (e) { alert(String(e.message || e)); }
}
function label(text, size) {
    var view = $.NSTextField.labelWithString($(text));
    view.font = $.NSFont.systemFontOfSize(size);
    view.lineBreakMode = 4;
    ui.root.addSubview(view);
    return view;
}
function button(title, action) {
    var view = $.NSButton.buttonWithTitleTargetAction($(title), controller, action);
    view.bezelStyle = 1;
    ui.root.addSubview(view);
    return view;
}
function frame(view, x, y, w, h) { view.setFrame($.NSMakeRect(x, y, w, h)); }
function layout() {
    if (!ui.scroll) return;
    var w = Number(ui.root.bounds.size.width), h = Number(ui.root.bounds.size.height);
    var compact = !!prefs.compact;
    frame(ui.heading, 20, h - 66, 100, 26);
    frame(ui.author, 116, h - 62, 90, 20);
    frame(ui.shortcut, w - 214, h - 66, 128, 26);
    frame(ui.compact, w - 82, h - 66, 64, 26);
    frame(ui.open, 18, h - 105, 88, 28);
    frame(ui.pin, 112, h - 105, 92, 28);
    frame(ui.theme, 210, h - 105, 86, 28);
    frame(ui.smaller, w - 116, h - 105, 44, 28);
    frame(ui.larger, w - 66, h - 105, 48, 28);
    frame(ui.opacityLabel, 22, h - 142, 58, 22);
    frame(ui.slider, 82, h - 142, w - 165, 24);
    frame(ui.opacityValue, w - 74, h - 142, 58, 22);
    frame(ui.chapterToggle, 18, h - 179, 118, 28);
    frame(ui.chapterList, 142, h - 179, w - 160, 28);
    frame(ui.spacingLabel, 22, h - 215, 58, 22);
    frame(ui.spacingSlider, 82, h - 215, w - 165, 24);
    frame(ui.spacingValue, w - 74, h - 215, 58, 22);
    frame(ui.search, 18, h - 253, w - 238, 26);
    frame(ui.searchPrev, w - 214, h - 253, 54, 26);
    frame(ui.searchNext, w - 154, h - 253, 54, 26);
    frame(ui.searchResult, w - 96, h - 250, 78, 20);
    [ui.heading, ui.author, ui.shortcut, ui.status, ui.open, ui.pin, ui.theme, ui.smaller, ui.larger, ui.opacityLabel, ui.slider, ui.opacityValue, ui.chapterToggle, ui.chapterList, ui.spacingLabel, ui.spacingSlider, ui.spacingValue, ui.search, ui.searchPrev, ui.searchNext, ui.searchResult].forEach(function(v) { v.hidden = compact; });
    ui.compact.title = compact ? '展开' : '收起';
    if (compact) frame(ui.compact, w - 82, h - 32, 64, 24);
    frame(ui.scroll, 12, compact ? 8 : 36, w - 24, Math.max(50, h - (compact ? 48 : 302)));
    frame(ui.status, 22, 10, w - 44, 20);
    ui.text.setFrameSize($.NSMakeSize(Number(ui.scroll.contentSize.width), Math.max(Number(ui.text.frame.size.height), Number(ui.scroll.contentSize.height))));
}
function applyOpacity() {
    // Slider tracking must not edit text storage, trigger full-book layout,
    // or write settings. The existing idle/quit saves persist the new value.
    ui.window.backgroundColor = $.NSColor.colorWithCalibratedWhiteAlpha(prefs.dark ? 0.07 : 0.98, prefs.opacity);
    ui.opacityValue.stringValue = Math.round(prefs.opacity * 100) + '%';
}
function changeOpacity(value) {
    prefs.opacity = Math.max(0, Math.min(1, value));
    applyOpacity();
}
function applyStyle() {
    var dark = prefs.dark;
    applyOpacity();
    ui.window.appearance = $.NSAppearance.appearanceNamed(dark ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua');
    ui.text.textColor = dark ? $.NSColor.whiteColor : $.NSColor.blackColor;
    ui.text.font = $.NSFont.systemFontOfSize(prefs.fontSize);
    var paragraph = $.NSMutableParagraphStyle.alloc.init;
    paragraph.lineSpacing = prefs.lineSpacing;
    paragraph.paragraphSpacing = prefs.fontSize * 0.65;
    ui.text.defaultParagraphStyle = paragraph;
    var attributes = $.NSMutableDictionary.dictionary;
    attributes.setObjectForKey(ui.text.font, $.NSFontAttributeName);
    attributes.setObjectForKey(ui.text.textColor, $.NSForegroundColorAttributeName);
    attributes.setObjectForKey(paragraph, $.NSParagraphStyleAttributeName);
    attributes.setObjectForKey($.NSNumber.numberWithDouble(0), $.NSStrokeWidthAttributeName);
    // Replace all attributes: no stroke, shadow, or background on any glyph.
    if (Number(ui.text.textStorage.length) > 0)
        ui.text.textStorage.setAttributesRange(attributes, $.NSMakeRange(0, Number(ui.text.textStorage.length)));
    ui.text.typingAttributes = attributes;
    ui.heading.textColor = ui.text.textColor;
    ui.author.textColor = ui.text.textColor;
    ui.status.textColor = ui.text.textColor.colorWithAlphaComponent(0.65);
    ui.opacityLabel.textColor = ui.status.textColor;
    ui.opacityValue.textColor = ui.status.textColor;
    ui.spacingLabel.textColor = ui.status.textColor;
    ui.spacingValue.textColor = ui.status.textColor;
    ui.searchResult.textColor = ui.text.textColor;
    ui.spacingValue.stringValue = prefs.lineSpacing + ' pt';
    ui.spacingSlider.doubleValue = prefs.lineSpacing;
    ui.pin.title = prefs.pinned ? '置顶：开' : '置顶：关';
    ui.theme.title = dark ? '浅色背景' : '深色背景';
    ui.window.level = prefs.pinned ? 3 : 0;
    ui.window.invalidateShadow;
}
function changeFont(delta) {
    var p = progress();
    prefs.fontSize = Math.max(12, Math.min(32, prefs.fontSize + delta));
    applyStyle(); restoreProgress(p); save();
}
ObjC.registerSubclass({
    name: 'MoyuReaderWindow',
    superclass: 'NSWindow',
    methods: {
        'sendEvent:': {
            types: ['void', ['id']],
            implementation: function(event) {
                if (!event || event.isNil()) return;
                // Option-only combinations can go directly to the focused view's
                // keyDown: without ever reaching performKeyEquivalent:.
                if (Number(event.type) === 10 && dispatchShortcut(event)) return;
                this.moyuDefaultSendEvent(event);
            }
        },
        'performKeyEquivalent:': {
            types: ['bool', ['id']],
            implementation: function(event) {
                if (dispatchShortcut(event)) return true;
                var modifiers = Number(event.modifierFlags) & 0x1e0000;
                if (modifiers === 0x100000 && Number(event.keyCode) === 3) { focusSearch(); return true; }
                if ((modifiers === 0x100000 || modifiers === 0x120000) && Number(event.keyCode) === 5) {
                    searchText(modifiers === 0x120000 ? -1 : 1); return true;
                }
                return false;
            }
        }
    }
});
// Keep the native implementation under a distinct selector. This avoids JXA's
// super-dispatch re-entering the override while forwarding ordinary events.
var defaultSendEventMethod = $.class_getInstanceMethod($.NSWindow, $.sel_registerName('sendEvent:'));
$.class_addMethod($.MoyuReaderWindow, $.sel_registerName('moyuDefaultSendEvent:'), $.method_getImplementation(defaultSendEventMethod), $.method_getTypeEncoding(defaultSendEventMethod));
ObjC.registerSubclass({
    name: 'MoyuReaderController',
    superclass: 'NSObject',
    protocols: ['NSWindowDelegate'],
    methods: {
        'openBook:': { types: ['void', ['id']], implementation: function() { importBook(); } },
        'opacityChanged:': { types: ['void', ['id']], implementation: function(sender) { changeOpacity(Number(sender.doubleValue)); } },
        'togglePin:': { types: ['void', ['id']], implementation: function() { prefs.pinned = !prefs.pinned; applyStyle(); save(); } },
        'toggleTheme:': { types: ['void', ['id']], implementation: function() { prefs.dark = !prefs.dark; applyStyle(); save(); } },
        'smaller:': { types: ['void', ['id']], implementation: function() { changeFont(-1); } },
        'larger:': { types: ['void', ['id']], implementation: function() { changeFont(1); } },
        'toggleChapters:': { types: ['void', ['id']], implementation: function() { toggleChapters(); } },
        'selectChapter:': { types: ['void', ['id']], implementation: function() { selectChapter(); } },
        'spacingChanged:': { types: ['void', ['id']], implementation: function(sender) { changeLineSpacing(Number(sender.doubleValue)); } },
        'searchNext:': { types: ['void', ['id']], implementation: function() { searchText(1); } },
        'searchPrev:': { types: ['void', ['id']], implementation: function() { searchText(-1); } },
        'focusSearch:': { types: ['void', ['id']], implementation: function() { focusSearch(); } },
        'compact:': { types: ['void', ['id']], implementation: function() { toggleCompact(); } },
        'hideReader:': { types: ['void', ['id']], implementation: function() { save(); $.NSApplication.sharedApplication.hide(null); } },
        'toggleReader:': { types: ['void', ['id']], implementation: function() { toggleReader(); } },
        'enableShortcut:': { types: ['void', ['id']], implementation: function() { enableShortcut(); } },
        'quitReader:': { types: ['void', ['id']], implementation: function() { save(); $.NSApplication.sharedApplication.terminate(null); } },
        'windowDidResize:': { types: ['void', ['id']], implementation: function() { layout(); } },
        'windowWillClose:': { types: ['void', ['id']], implementation: function() { save(); $.NSApplication.sharedApplication.terminate(null); } }
    }
});
function menuItem(title, action, key) {
    var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(title), action, $(key));
    item.target = controller;
    return item;
}
function build() {
    var app = $.NSApplication.sharedApplication;
    app.setActivationPolicy(0);
    controller = $.MoyuReaderController.alloc.init;
    ui.window = $.MoyuReaderWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, 480, 640), 1 | 2 | 4 | 8 | 32768, 2, false);
    ui.window.releasedWhenClosed = false;
    ui.window.title = '摸鱼阅读';
    ui.window.titleVisibility = 1;
    ui.window.titlebarAppearsTransparent = true;
    ui.window.opaque = false;
    // With transparent windows the window shadow can outline individual glyphs.
    ui.window.hasShadow = false;
    ui.window.minSize = $.NSMakeSize(440, 420);
    ui.window.collectionBehavior = 1 | 256;
    ui.root = ui.window.contentView;
    ui.heading = label('摸鱼阅读', 19);
    ui.heading.font = $.NSFont.boldSystemFontOfSize(19);
    ui.author = label('作者 yu1', 11);
    ui.open = button('导入 TXT', 'openBook:');
    ui.pin = button('置顶：开', 'togglePin:');
    ui.theme = button('浅色背景', 'toggleTheme:');
    ui.smaller = button('A−', 'smaller:');
    ui.larger = button('A+', 'larger:');
    ui.compact = button('收起', 'compact:');
    ui.shortcut = button('启用全局快捷键', 'enableShortcut:');
    ui.opacityLabel = label('背景', 12);
    ui.opacityValue = label('', 12);
    ui.slider = $.NSSlider.alloc.initWithFrame($.NSMakeRect(0, 0, 100, 24));
    ui.slider.minValue = 0; ui.slider.maxValue = 1; ui.slider.doubleValue = prefs.opacity;
    ui.slider.continuous = true; ui.slider.target = controller; ui.slider.action = 'opacityChanged:';
    ui.root.addSubview(ui.slider);
    ui.chapterToggle = button('识别目录：关', 'toggleChapters:');
    ui.chapterList = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(0, 0, 100, 28), false);
    ui.chapterList.target = controller; ui.chapterList.action = 'selectChapter:';
    ui.root.addSubview(ui.chapterList);
    ui.spacingLabel = label('行间距', 12);
    ui.spacingValue = label('', 12);
    ui.spacingSlider = $.NSSlider.alloc.initWithFrame($.NSMakeRect(0, 0, 100, 24));
    ui.spacingSlider.minValue = 0; ui.spacingSlider.maxValue = 40;
    ui.spacingSlider.continuous = false;
    ui.spacingSlider.target = controller; ui.spacingSlider.action = 'spacingChanged:';
    ui.root.addSubview(ui.spacingSlider);
    ui.search = $.NSSearchField.alloc.initWithFrame($.NSMakeRect(0, 0, 180, 26));
    ui.search.placeholderString = '搜索正文（⌘F）';
    ui.search.target = controller; ui.search.action = 'searchNext:';
    ui.search.sendsSearchStringImmediately = false;
    ui.search.sendsWholeSearchString = true;
    ui.root.addSubview(ui.search);
    ui.searchPrev = button('上一处', 'searchPrev:');
    ui.searchNext = button('下一处', 'searchNext:');
    ui.searchResult = label('输入关键词', 11);
    ui.scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(12, 36, 456, 446));
    ui.scroll.drawsBackground = false;
    ui.scroll.hasVerticalScroller = true;
    ui.scroll.autohidesScrollers = true;
    ui.scroll.borderType = 0;
    ui.text = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 456, 446));
    ui.text.editable = false;
    ui.text.selectable = true;
    ui.text.drawsBackground = false;
    ui.text.richText = false;
    ui.text.usesAdaptiveColorMappingForDarkAppearance = false;
    ui.text.verticallyResizable = true;
    ui.text.horizontallyResizable = false;
    ui.text.minSize = $.NSMakeSize(0, 0);
    ui.text.maxSize = $.NSMakeSize(10000000, 10000000);
    ui.text.autoresizingMask = 2;
    ui.text.textContainer.containerSize = $.NSMakeSize(456, 10000000);
    ui.text.textContainer.widthTracksTextView = true;
    ui.text.textContainerInset = $.NSMakeSize(12, 12);
    ui.scroll.documentView = ui.text;
    ui.root.addSubview(ui.scroll);
    ui.status = label('', 11);
    layout();
    ui.window.delegate = controller;
    var main = $.NSMenu.alloc.init;
    var root = $.NSMenuItem.alloc.init;
    var menu = $.NSMenu.alloc.initWithTitle('摸鱼阅读');
    menu.addItem(menuItem('导入 TXT…', 'openBook:', 'o'));
    menu.addItem(menuItem('搜索正文…', 'focusSearch:', 'f'));
    menu.addItem(menuItem('查找下一处', 'searchNext:', 'g'));
    var previousMatch = menuItem('查找上一处', 'searchPrev:', 'g');
    previousMatch.keyEquivalentModifierMask = 0x100000 | 0x20000;
    menu.addItem(previousMatch);
    menu.addItem(menuItem('收起 / 展开工具栏', 'compact:', 't'));
    menu.addItem(menuItem('置顶 / 取消置顶', 'togglePin:', 'p'));
    menu.addItem(menuItem('隐藏阅读器', 'hideReader:', 'h'));
    var toggleItem = menuItem('隐藏 / 恢复阅读器', 'toggleReader:', 'z');
    toggleItem.keyEquivalentModifierMask = 0x80000;
    menu.addItem(toggleItem);
    var compactItem = menuItem('收起 / 展开阅读器', 'compact:', 'x');
    compactItem.keyEquivalentModifierMask = 0x80000;
    menu.addItem(compactItem);
    menu.addItem(menuItem('启用全局快捷键…', 'enableShortcut:', ''));
    menu.addItem($.NSMenuItem.separatorItem);
    menu.addItem(menuItem('退出摸鱼阅读', 'quitReader:', 'q'));
    root.submenu = menu; main.addItem(root); app.mainMenu = main;
    var cached = !testing && prefs.lastPath ? stringAt(base + '/current.txt') : null;
    if (cached !== null && cached !== false)
        showBook(cached, prefs.lastTitle, prefs.lastPath, prefs.progress[prefs.lastPath] || 0);
    else
        showBook('留一点时间，给故事。\n\n点击「导入 TXT」，打开你正在读的小说。\n\n拖动「背景」滑块，只改变背景透明度，文字仍保持清晰。0% 为全透明背景。\n\n文字为纯黑 / 纯白，无描边、无阴影。可手动识别章节目录、调节行间距，用 ⌘F 搜索定位。也可以置顶、调整字号，或收起工具栏。拖动窗口顶部移动，拖动边缘调整大小。\n\n⌥Z　隐藏 / 恢复窗口\n点击「启用全局快捷键」并允许辅助功能后，可在其他应用里使用。\n\n⌘O　导入小说\n⌥X　收起 / 展开\n⌘P　切换置顶\n⌘H　隐藏窗口\n⌘Q　保存并退出\n\n阅读进度会自动保存在本机，下次打开继续读。', '', '', 0);
    ui.window.center;
    if (!testing) {
        ui.window.setFrameAutosaveName('MoyuReaderWindow');
        ui.window.makeKeyAndOrderFront(null);
        app.activateIgnoringOtherApps(true);
        ui.window.makeFirstResponder(ui.text);
        refreshShortcut();
    }
}
function isSelfTestArguments(args) {
    // A Finder/app-launch run event may supply a null Apple Event descriptor,
    // rather than the JavaScript argument array supplied by osascript.
    // Never index a bridged descriptor: it can send `count` to NSNull.
    return Array.isArray(args) && args.length > 0 && args[0] === '--self-test';
}
function run(args) {
    testing = isSelfTestArguments(args);
    loadPrefs();
    if (!testing && !fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(base), true, $.NSDictionary.dictionary, null)) {
        alert('无法创建本地阅读数据目录，请检查用户目录的写入权限。');
        return;
    }
    build();
    if (testing) {
        function assert(ok, description) { if (!ok) throw new Error(description); }
        assert(!isSelfTestArguments(undefined), 'Launch without arguments');
        assert(!isSelfTestArguments(null), 'Launch with null arguments');
        assert(!isSelfTestArguments($.NSNull.null), 'Launch with bridged null descriptor');
        assert(!isSelfTestArguments([]), 'Launch with empty argument array');
        assert(isSelfTestArguments(['--self-test']), 'Command-line test arguments');
        var testDir = ObjC.unwrap($.NSTemporaryDirectory()) + 'moyu-reader-startup-check';
        assert(Boolean(fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(testDir), true, $.NSDictionary.dictionary, null)), 'Create startup data directory');
        writeText('启动缓存检查', testDir + '/current.txt');
        assert(stringAt(testDir + '/current.txt') === '启动缓存检查', 'Write and read startup cache');
        fm.removeItemAtPathError($(testDir), null);
        var sample = '第一章\n你好，世界。';
        assert(decode($(sample).dataUsingEncoding($.NSUTF8StringEncoding)) === sample, 'UTF-8 decode');
        assert(decode($(sample).dataUsingEncoding(0x80000632)) === sample, 'GB18030 decode');
        assert(decode($(sample).dataUsingEncoding($.NSUTF16StringEncoding)) === sample, 'UTF-16 BOM decode');
        prefs.opacity = 0; applyStyle();
        assert(Number(ui.window.backgroundColor.alphaComponent) === 0, 'Transparent background');
        assert(Number(ui.text.textColor.alphaComponent) === 1, 'Opaque text');
        assert(!Boolean(ui.window.hasShadow), 'No window or glyph outline shadow');
        prefs.dark = true; applyStyle();
        assert(Boolean(ui.text.textColor.isEqual($.NSColor.whiteColor)), 'Pure white text');
        prefs.dark = false; applyStyle();
        assert(Boolean(ui.text.textColor.isEqual($.NSColor.blackColor)), 'Pure black text');
        var attrs = ui.text.textStorage.attributesAtIndexEffectiveRange(0, null);
        assert(Number(attrs.objectForKey($.NSStrokeWidthAttributeName).doubleValue) === 0, 'No glyph stroke');
        assert(attrs.objectForKey($.NSShadowAttributeName).isNil(), 'No glyph shadow');
        assert(isToggleShortcut({keyCode: 6, modifierFlags: 0x80000, isARepeat: false}), 'Option-Z exact match');
        assert(isToggleShortcut({keyCode: 6, modifierFlags: 0x90000, isARepeat: false}), 'Option-Z with caps lock');
        assert(!isToggleShortcut({keyCode: 6, modifierFlags: 0, isARepeat: false}), 'Ignore plain Z');
        assert(!isToggleShortcut({keyCode: 6, modifierFlags: 0x100000, isARepeat: false}), 'Ignore Cmd-Z');
        assert(!isToggleShortcut({keyCode: 6, modifierFlags: 0x180000, isARepeat: false}), 'Ignore Cmd-Option-Z');
        assert(!isToggleShortcut({keyCode: 46, modifierFlags: 0x180000, isARepeat: false}), 'Ignore previous shortcut');
        assert(!isToggleShortcut({keyCode: 6, modifierFlags: 0x80000, isARepeat: true}), 'Ignore held key repeats');
        assert(shortcutAction({keyCode: 7, modifierFlags: 0x80000}) === 'compact', 'Option-X compact shortcut');
        assert(shortcutAction({keyCode: 7, modifierFlags: 0x100000}) === '', 'Do not intercept Cmd-X');
        var actions = [];
        assert(dispatchShortcut({keyCode: 6, modifierFlags: 0x80000, isARepeat: false}, function(a) { actions.push(a); }), 'Consume local Option-Z');
        dispatchShortcut({keyCode: 7, modifierFlags: 0x80000, isARepeat: false}, function(a) { actions.push(a); });
        dispatchShortcut({keyCode: 7, modifierFlags: 0x80000, isARepeat: true}, function(a) { actions.push(a); });
        assert(actions.join(',') === 'visibility,compact', 'Dispatch both shortcuts exactly once');
        prefs.pinned = true; applyStyle(); assert(Number(ui.window.level) === 3, 'Floating window');
        prefs.pinned = false; applyStyle(); assert(Number(ui.window.level) === 0, 'Normal window');
        prefs.compact = true; layout(); assert(Boolean(ui.slider.hidden), 'Compact controls');
        assert(Boolean(ui.heading.hidden) && Boolean(ui.author.hidden) && Boolean(ui.shortcut.hidden) && Boolean(ui.status.hidden), 'Hide title, author and status when compact');
        prefs.compact = false; layout(); assert(!Boolean(ui.slider.hidden), 'Expanded controls');
        assert(!Boolean(ui.heading.hidden) && !Boolean(ui.author.hidden), 'Restore title and author when expanded');
        assert(ObjC.unwrap(ui.heading.stringValue) === '摸鱼阅读' && ObjC.unwrap(ui.author.stringValue) === '作者 yu1', 'Header credit');
        var event = $.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(10, $.NSMakePoint(0, 0), 0x80000, 0, Number(ui.window.windowNumber), $(), $('≈'), $('x'), false, 7);
        assert(Boolean(ui.window.performKeyEquivalent(event)), 'Native window consumes Option-X');
        assert(prefs.compact === true, 'Native local callback handles Option-X');
        ui.window.performKeyEquivalent(event);
        assert(prefs.compact === false, 'Native local callback expands on second Option-X');
        // Exercise the window's complete event route, not just key equivalents.
        ui.window.makeFirstResponder(ui.text);
        ui.window.sendEvent(event);
        assert(prefs.compact === true, 'Window sendEvent handles Option-X with body focused');
        ui.window.sendEvent(event);
        assert(prefs.compact === false, 'Window sendEvent expands on second Option-X');
        ui.window.makeFirstResponder(ui.search);
        ui.window.sendEvent(event);
        assert(prefs.compact === true, 'Option-X works while search field has focus');
        ui.window.sendEvent(event);
        assert(prefs.compact === false, 'Option-X restores tools from search focus');
        var visibilityCalls = 0;
        shortcutTestSink = function(action) { if (action === 'visibility') visibilityCalls++; };
        var visibilityEvent = $.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(10, $.NSMakePoint(0, 0), 0x80000, 0, Number(ui.window.windowNumber), $(), $('Ω'), $('z'), false, 6);
        ui.window.sendEvent(visibilityEvent);
        assert(visibilityCalls === 1, 'Window sendEvent dispatches Option-Z once');
        shortcutTestSink = null;
        var normalEvent = $.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(10, $.NSMakePoint(0, 0), 0, 0, Number(ui.window.windowNumber), $(), $('z'), $('z'), false, 6);
        ui.window.sendEvent(normalEvent);
        var callbackReceived = false;
        var center = $.NSNotificationCenter.defaultCenter;
        var observer = center.addObserverForNameObjectQueueUsingBlock($('MoyuReaderCallbackCheck'), $(), $(), function() { callbackReceived = true; });
        center.postNotificationNameObject($('MoyuReaderCallbackCheck'), $());
        center.removeObserver(observer);
        assert(callbackReceived, 'Native void callback actually invokes JavaScript');
        showBook(Array(300).join(sample + '\n'), '测试小说', '/test.txt', 0.5);
        assert(Math.abs(progress() - 0.5) < 0.03, 'Restore reading position');
        ui.text.setSelectedRange($.NSMakeRange(5, 2));
        var textEdits = 0, synchronousSaves = 0;
        var opacityObserver = center.addObserverForNameObjectQueueUsingBlock($.NSTextStorageDidProcessEditingNotification, ui.text.textStorage, $(), function() { textEdits++; });
        applyStyle();
        assert(textEdits > 0, 'Text storage observer detects full style changes');
        textEdits = 0;
        var originalSave = save;
        save = function() { synchronousSaves++; };
        try {
            for (var opacityStep = 0; opacityStep <= 100; opacityStep++) {
                ui.slider.doubleValue = opacityStep / 100;
                controller.opacityChanged(ui.slider);
            }
        } finally {
            save = originalSave;
            center.removeObserver(opacityObserver);
        }
        assert(textEdits === 0, '101 slider events do not edit or restyle the book');
        assert(synchronousSaves === 0, 'Slider events do not synchronously save to disk');
        assert(Number(ui.text.selectedRange.location) === 5 && Number(ui.text.selectedRange.length) === 2, 'Opacity preserves text selection');
        assert(Math.abs(progress() - 0.5) < 0.03, 'Opacity preserves scroll position');
        assert(prefs.opacity === 1 && Number(ui.window.backgroundColor.alphaComponent) === 1, 'Slider final value applied');
        assert(ObjC.unwrap(ui.opacityValue.stringValue) === '100%', 'Percentage display updated');
        changeOpacity(0);
        assert(Number(ui.window.backgroundColor.alphaComponent) === 0 && Number(ui.text.textColor.alphaComponent) === 1, 'Transparent background keeps text opaque');
        changeFont(1); assert(Math.abs(progress() - 0.5) < 0.03, 'Preserve position after font change');
        changeLineSpacing(24);
        assert(prefs.lineSpacing === 24 && Number(ui.text.defaultParagraphStyle.lineSpacing) === 24, 'Apply custom line spacing');
        assert(Math.abs(progress() - 0.5) < 0.03, 'Preserve reading progress after spacing change');
        var fixture = '😀开场\n序章\n正文提到第一章，但不是章节标题。\n第一章 起点\n你好，ABC。\n第二章 相逢\n再见，abc。[a.b]\nChapter 3 Home\n尾声\n';
        showBook(fixture, '目录搜索测试', '/test-chapters.txt', 0);
        assert(!chaptersEnabled && chapters.length === 0, 'Chapter recognition off until explicitly enabled');
        assert(!Boolean(ui.chapterList.enabled), 'No automatic chapter scanning on import');
        toggleChapters();
        assert(chapters.length === 5, 'Recognize Chinese, English and prologue headings');
        assert(fixture.slice(chapters[1].index, chapters[1].index + chapters[1].length) === '第一章 起点', 'UTF-16 chapter offsets after emoji');
        ui.chapterList.selectItemAtIndex(3); selectChapter();
        assert(Number(ui.text.selectedRange.location) === fixture.indexOf('第二章'), 'Chapter selection locates text');
        ui.search.stringValue = 'abc'; searchText(1);
        assert(Number(ui.text.selectedRange.location) === fixture.indexOf('ABC'), 'Case-insensitive search selects first result');
        searchText(1);
        assert(Number(ui.text.selectedRange.location) === fixture.indexOf('abc'), 'Find next result');
        searchText(1);
        assert(Number(ui.text.selectedRange.location) === fixture.indexOf('ABC') && searchState.range.wrapped, 'Wrap search at end of book');
        searchText(-1);
        assert(Number(ui.text.selectedRange.location) === fixture.indexOf('abc') && searchState.range.wrapped, 'Wrap backwards search');
        ui.search.stringValue = '[a.b]'; searchText(1);
        assert(Number(ui.text.selectedRange.location) === fixture.indexOf('[a.b]'), 'Search punctuation literally');
        ui.search.stringValue = '不存在的词'; searchText(1);
        assert(searchState.range === null && ObjC.unwrap(ui.searchResult.stringValue) === '未找到', 'No-match state');
        ui.search.stringValue = ''; searchText(1);
        assert(ObjC.unwrap(ui.searchResult.stringValue) === '输入关键词', 'Empty search is safe');
        prefs.compact = true; layout();
        assert(Boolean(ui.search.hidden) && Boolean(ui.chapterList.hidden) && Boolean(ui.spacingSlider.hidden), 'New tools hide in compact mode');
        var findEvent = $.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(10, $.NSMakePoint(0, 0), 0x100000, 0, Number(ui.window.windowNumber), $(), $('f'), $('f'), false, 3);
        assert(Boolean(ui.window.performKeyEquivalent(findEvent)) && !prefs.compact, 'Cmd-F opens search from compact mode');
        showBook('没有章节标题的正文。', '另一本书', '/another.txt', 0);
        assert(!chaptersEnabled && chapters.length === 0 && searchState.range === null, 'New book resets directory and search');
        toggleChapters();
        assert(chapters.length === 0 && !Boolean(ui.chapterList.enabled), 'Book without chapter headings');
        assert(recognizeChapters('第一章 重复\n第一章 重复\n').length === 2, 'Repeated headings retain both locations');
        return 'PASS: 101 opacity slider events without text edits or disk saves, selection and scroll preservation, chapter recognition and jumps, Unicode search and wrap, line spacing, native keyboard callbacks, core reader checks';
    }
}
function idle() { refreshShortcut(); save(); return 2; }
function quit() { save(); }
