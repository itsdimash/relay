#import "RelayNotchPanel.h"
#import "RelayNowPlaying.h"
#import "RelayNotchGlow.h"
#import "RelayDictation.h"
#import "RelaySpeech.h"
#import "RelayWake.h"
#import "RelayActions.h"
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>

NSString *const RelayNotchEnabledKey = @"RelayNotchEnabled";
static NSString *const RelayGlowStyleKey = @"RelayNotchGlowStyle"; // off, line, halo or sparks: the light around the notch

// The panel has three shapes. Heights are measured below the notch band, so they follow the screen's notch.
typedef NS_ENUM(NSInteger, RelayPanelMode) {
    RelayPanelModePill = 0,    // a track just changed: cover, title and a moving equalizer, then it retracts
    RelayPanelModeCompact = 1, // the pointer is on the notch: tabs for Music, Notes and Task
    RelayPanelModeFull = 2,    // double-tap right Command, or something needs the person: adds the Office
};

static const CGFloat PillWidth = 380;
static const CGFloat PillBodyHeight = 46;
static const CGFloat CompactWidth = 470;     // wide enough for four tabs on each side of the notch
static const CGFloat CompactBodyHeight = 170;
static const CGFloat FullWidth = 780;
static const CGFloat FullBodyHeight = 312;
static const CGFloat CardWidth = 680;       // the full panel when it only holds the card for a spoken request: wide enough for
static const CGFloat CardBodyHeight = 186;  // its row of choices (and Russian), and no taller than the card
static const CGFloat PanelRadius = 26;
static const CGFloat FitMaxScreenShare = 0.55; // the small panel never grows taller than this share of the screen; the page scrolls beyond it
static const NSUInteger ClipboardMaxLength = 5000; // the most a translation takes
static const NSTimeInterval PillVisibleSeconds = 4.2; // how long a track-change pill stays out
static const NSTimeInterval PillMinGap = 2.0;         // quick skipping does not flash the pill again and again
static const CGFloat TriggerMargin = 55;      // hot zone is the notch plus this much on each side
static const CGFloat DragZoneDepth = 95;      // a file being dragged is held by its icon, so the pointer sits this far below the notch band at most
static const CGFloat DragZoneMargin = 170;    // and this much to each side of the notch
static const NSTimeInterval ShowDelay = 0.15; // the pointer must rest in the hot zone this long
static const NSTimeInterval HideDelay = 0.45; // grace period after the pointer leaves the panel
static const NSTimeInterval DoneVisibleSeconds = 7.0;
static const NSTimeInterval ReminderVisibleSeconds = 14.0; // a reminder stays longer: the person may have looked away
static const NSTimeInterval TapMaxHold = 0.30;    // a Command "tap" is pressed and released within this time
static const NSTimeInterval DoubleTapWindow = 0.45; // two taps within this time toggle the panel
static const CGEventFlags RightCommandMask = 0x00000010; // device-dependent bit for the right Command key
static const CGEventFlags LeftCommandMask = 0x00000008;
static const CGEventFlags RightOptionMask = 0x00000040; // the right Option key: hold it to talk
static const CGEventFlags LeftOptionMask = 0x00000020;
static const NSTimeInterval VoiceKeyHold = 0.35;       // held this long on its own, it is "talk", not a typing shortcut
static const NSTimeInterval VoiceVisibleSeconds = 20.0;

// A borderless panel that can take clicks and keys without making Relay the active app.
@interface RelayNotchWindow : NSPanel
@end

@implementation RelayNotchWindow
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
// Borderless windows may sit partly above the screen, which the slide-in animation needs.
- (NSRect)constrainFrameRect:(NSRect)frameRect toScreen:(NSScreen *)screen { return frameRect; }
@end

// What the web view is doing with a drag that is over it.
typedef NS_ENUM(NSInteger, RelayDragKind) {
    RelayDragNone = 0, // no drag over the view
    RelayDragWeb,      // something for the page itself: WebKit handles it
    RelayDragFiles,    // files from Finder or another app: they go to the Deliver shelf
    RelayDragOwn,      // files the panel is dragging out itself: never taken back in
};

// A web page is never given the path of a dropped file, so files dragged onto the panel are taken here, in the app,
// and handed to the page as plain paths.
@interface RelayNotchWebView : WKWebView
@property(nonatomic, copy) void (^fileDragHandler)(BOOL over);               // files are over the panel, or left it
@property(nonatomic, copy) void (^filesDropHandler)(NSArray<NSString *> *paths); // files were dropped on the panel
@end

// Whether a drag carries files. Some apps hand over a promise instead of a path: the file is only written when asked for.
// Before a drag reaches one of our windows the system may not say what it carries; that counts as maybe.
static BOOL CarriesFiles(NSArray<NSString *> *types) {
    if (!types.count) return YES;
    if ([types containsObject:NSPasteboardTypeFileURL] || [types containsObject:@"NSFilenamesPboardType"]) return YES;
    for (NSString *type in NSFilePromiseReceiver.readableDraggedTypes) {
        if ([types containsObject:type]) return YES;
    }
    return NO;
}

static NSArray<NSFilePromiseReceiver *> *DroppedFilePromises(id<NSDraggingInfo> info) {
    return [info.draggingPasteboard readObjectsForClasses:@[ NSFilePromiseReceiver.class ] options:nil] ?: @[];
}

static NSArray<NSString *> *DroppedFilePaths(id<NSDraggingInfo> info) {
    NSArray *urls = [info.draggingPasteboard readObjectsForClasses:@[ NSURL.class ]
                                                           options:@{ NSPasteboardURLReadingFileURLsOnlyKey: @YES }];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *url in urls) {
        NSString *path = url.filePathURL.path ?: url.path;
        if (path.length) [paths addObject:path];
    }
    return paths;
}

@implementation RelayNotchWebView {
    RelayDragKind _dragKind;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    if (sender.draggingSource) { // the panel's own drag out
        _dragKind = RelayDragOwn;
        return NSDragOperationNone;
    }
    if (DroppedFilePaths(sender).count || DroppedFilePromises(sender).count) {
        _dragKind = RelayDragFiles;
        if (self.fileDragHandler) self.fileDragHandler(YES);
        return NSDragOperationCopy;
    }
    _dragKind = RelayDragWeb;
    return [super draggingEntered:sender];
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
    if (_dragKind == RelayDragFiles) return NSDragOperationCopy;
    if (_dragKind == RelayDragOwn) return NSDragOperationNone;
    return [super draggingUpdated:sender];
}

- (void)draggingExited:(id<NSDraggingInfo>)sender {
    RelayDragKind kind = _dragKind;
    _dragKind = RelayDragNone;
    if (kind == RelayDragFiles) {
        if (self.fileDragHandler) self.fileDragHandler(NO);
    } else if (kind != RelayDragOwn) {
        [super draggingExited:sender];
    }
}

// The app that is being dropped from writes each promised file into a folder of ours; once all of them are there,
// the page puts them on the shelf. They are in Caches, so the system may clear them out in time.
- (void)receivePromises:(NSArray<NSFilePromiseReceiver *> *)receivers {
    NSURL *caches = [NSFileManager.defaultManager URLForDirectory:NSCachesDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:nil];
    NSURL *folder = [[caches URLByAppendingPathComponent:@"Relay/Deliver" isDirectory:YES] URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
    if (!folder || ![NSFileManager.defaultManager createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil]) return;
    NSOperationQueue *queue = [[NSOperationQueue alloc] init];
    queue.maxConcurrentOperationCount = 1; // the readers run one at a time, so the counters need no lock
    __block NSInteger remaining = 0;
    for (NSFilePromiseReceiver *receiver in receivers) remaining += MAX(1, (NSInteger)receiver.fileNames.count);
    NSMutableArray<NSString *> *received = [NSMutableArray array];
    __weak RelayNotchWebView *weakSelf = self;
    for (NSFilePromiseReceiver *receiver in receivers) {
        [receiver receivePromisedFilesAtDestination:folder options:@{} operationQueue:queue reader:^(NSURL *fileURL, NSError *error) {
            (void)receivers.count; // keeps the receivers alive until their files have arrived
            if (fileURL && !error) [received addObject:fileURL.path];
            if (--remaining > 0) return;
            NSArray<NSString *> *done = [received copy];
            dispatch_async(dispatch_get_main_queue(), ^{
                RelayNotchWebView *strongSelf = weakSelf;
                if (strongSelf && done.count && strongSelf.filesDropHandler) strongSelf.filesDropHandler(done);
            });
        }];
    }
}

- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender {
    if (_dragKind == RelayDragFiles) return YES;
    if (_dragKind == RelayDragOwn) return NO;
    return [super prepareForDragOperation:sender];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    RelayDragKind kind = _dragKind;
    _dragKind = RelayDragNone;
    if (kind == RelayDragFiles) {
        NSArray<NSString *> *paths = DroppedFilePaths(sender);
        NSArray<NSFilePromiseReceiver *> *promises = paths.count ? @[] : DroppedFilePromises(sender);
        if (self.fileDragHandler) self.fileDragHandler(NO);
        if (paths.count && self.filesDropHandler) self.filesDropHandler(paths);
        if (promises.count) [self receivePromises:promises];
        return paths.count > 0 || promises.count > 0;
    }
    if (kind == RelayDragOwn) return NO;
    return [super performDragOperation:sender];
}
@end

// Lets the web view hold the message handler without keeping the panel alive in a cycle.
@interface RelayWeakMessageHandler : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) id<WKScriptMessageHandler> target;
@end

@implementation RelayWeakMessageHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    [self.target userContentController:controller didReceiveScriptMessage:message];
}
@end

// An almost invisible window that waits in the zone around the notch while a mouse button is down. Whatever app a drag
// comes from, and whatever it puts on the drag board, the system tells this window when a drag with files arrives over
// it; then the panel opens. It exists only while a button is held in that zone, so it never gets in the way of a click.
@interface RelayDragCatcherView : NSView
@property(nonatomic, copy) void (^fileDragArrived)(void);
@end

@implementation RelayDragCatcherView
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        NSMutableArray<NSPasteboardType> *types = [NSMutableArray arrayWithObjects:NSPasteboardTypeFileURL, @"NSFilenamesPboardType", nil];
        [types addObjectsFromArray:NSFilePromiseReceiver.readableDraggedTypes];
        [self registerForDraggedTypes:types];
    }
    return self;
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    if (sender.draggingSource) return NSDragOperationNone; // the panel's own drag out
    if (self.fileDragArrived) self.fileDragArrived();
    return NSDragOperationCopy;
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
    return sender.draggingSource ? NSDragOperationNone : NSDragOperationCopy;
}
@end

@interface RelayNotchPanel () <WKScriptMessageHandler, WKNavigationDelegate, NSDraggingSource, RelayDictationDelegate, RelaySpeechDelegate, RelayWakeDelegate>
@property(nonatomic, strong) NSURL *pageURL;
@property(nonatomic, strong) RelayNotchWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSTimer *pollTimer;
@property(nonatomic, strong) id activity;       // keeps macOS from slowing the pointer watch (App Nap) when Relay is in the background
@property(nonatomic, strong) id mouseMonitor;   // wakes the watch on every pointer move, in any app
@property(nonatomic, strong) NSTimer *showTimer;
@property(nonatomic, strong) NSTimer *hideTimer;
@property(nonatomic, strong) NSTimer *doneTimer;
@property(nonatomic) BOOL shown;
@property(nonatomic) BOOL pinned;   // stays until the pointer has visited and left
@property(nonatomic) BOOL hovered;  // the pointer has been over the panel since it appeared
@property(nonatomic, strong) NSTimer *frameTimer;
@property(nonatomic, strong) NSScreen *screen;
@property(nonatomic) BOOL sticky;   // opened with the keyboard: stays until toggled again
@property(nonatomic) BOOL holding;  // the person is typing a note: do not close because the pointer left
@property(nonatomic, strong) RelayNowPlaying *nowPlaying; // what is playing, shown as a strip in the panel
@property(nonatomic, strong) RelayDictation *dictation; // speech to text for the note field
@property(nonatomic, strong) RelaySpeech *speech;       // text to speech: answers said out loud
@property(nonatomic, strong) RelayWake *wake;           // "Hey Relay": listens all the time, only when the person turned it on
@property(nonatomic) BOOL wakeDictating;                // the microphone is in use for dictation: the wake word listener waits
@property(nonatomic) BOOL wakeSpeaking;                 // an answer is being said out loud: it must not be heard as "Hey Relay"
@property(nonatomic) BOOL cardSize;       // the full panel is the small one that only holds a spoken request's card
@property(nonatomic) BOOL laidOutCard;    // ... and whether the page was last laid out that way
@property(nonatomic) CGFloat fitHeight;   // the Translate page asked the small panel for this much body height (0: the usual size)
@property(nonatomic, strong) NSRunningApplication *typeTarget; // the app a spoken "type …" goes to, as shown to the person
@property(nonatomic) BOOL optionDown;       // the right Option key is down
@property(nonatomic) BOOL optionValid;      // and nothing else was pressed with it
@property(nonatomic) BOOL voiceKeyActive;   // it has been held long enough: the microphone is on
@property(nonatomic) CFAbsoluteTime optionPressedAt;
@property(nonatomic) BOOL commandDown;
@property(nonatomic) BOOL commandTapValid;
@property(nonatomic) CFAbsoluteTime commandPressedAt;
@property(nonatomic) CFAbsoluteTime lastTapAt;
@property(nonatomic) CGFloat progress; // 0: the size of the notch, 1: fully open
@property(nonatomic) RelayPanelMode mode;
@property(nonatomic) NSSize shownSize;  // the size at progress 1 for the current mode (animates between modes)
@property(nonatomic) NSSize contentSize; // what the page is laid out at: the size of the current mode, never animated
@property(nonatomic, strong) NSTimer *sizeTimer;
@property(nonatomic, strong) NSTimer *pillTimer;
@property(nonatomic, copy) NSString *modeView; // the view the page was last asked to show
@property(nonatomic) CFAbsoluteTime lastPillAt;
@property(nonatomic, strong) RelayNotchGlow *glow;       // light around the closed notch
@property(nonatomic, strong) NSTimer *agentTimer;       // asks the engine whether agents are working
@property(nonatomic, copy) NSString *agentActor;        // nil when no task is running
@property(nonatomic, strong) NSColor *musicColor;       // the colour of the cover that is playing
@property(nonatomic, copy) NSString *musicColorSource;  // the artwork that colour came from
@property(nonatomic, copy) NSArray<NSString *> *armedPaths; // the files of the Deliver row that was pressed: dragged out once the pointer moves
@property(nonatomic) NSPoint armedAt;                       // where the pointer was when the row was pressed
@property(nonatomic) BOOL draggingOut;                      // files are being dragged out of the panel
@property(nonatomic) NSInteger dragBoardCount;              // the drag board's change count while no mouse button was down
@property(nonatomic) NSInteger dragOutIdleTicks;            // pointer ticks since a drag out last had the mouse button down
@property(nonatomic, strong) NSPanel *catcher;              // waits for a drag with files in the zone around the notch
@end

@implementation RelayNotchPanel

- (instancetype)initWithPageURL:(NSURL *)pageURL {
    self = [super init];
    if (self) {
        [NSUserDefaults.standardUserDefaults registerDefaults:@{RelayNotchEnabledKey: @YES, RelayGlowStyleKey: @"line"}];
        _pageURL = pageURL;
        [self buildWindow];
        [self buildCatcher];
        [self installMonitors];
        _nowPlaying = [[RelayNowPlaying alloc] init];
        __weak RelayNotchPanel *weakSelf = self;
        _nowPlaying.handler = ^(NSDictionary *state) { [weakSelf pushNowPlaying:state]; };
        _nowPlaying.trackChangeHandler = ^(NSDictionary *state) {
            [weakSelf.glow burst];
            [weakSelf showTrackPill];
        };
        _glow = [[RelayNotchGlow alloc] init];
        _glow.style = [NSUserDefaults.standardUserDefaults stringForKey:RelayGlowStyleKey];
        if (self.enabled) [self startAmbient];
    }
    return self;
}

- (void)dealloc {
    [self removeMonitors];
}

#pragma mark - Setting

- (BOOL)enabled {
    return [NSUserDefaults.standardUserDefaults boolForKey:RelayNotchEnabledKey];
}

- (void)setEnabled:(BOOL)enabled {
    [NSUserDefaults.standardUserDefaults setBool:enabled forKey:RelayNotchEnabledKey];
    if (enabled) {
        [self startAmbient];
    } else {
        [self.catcher orderOut:nil];
        [self hideAnimated:YES];
        [self stopAmbient];
    }
}

#pragma mark - Light around the notch

static NSColor *RGB(CGFloat r, CGFloat g, CGFloat b) { return [NSColor colorWithSRGBRed:r / 255 green:g / 255 blue:b / 255 alpha:1]; }

// The colour of the cover: vivid pixels count most, and dark covers are lifted so the light is visible.
static NSColor *DominantColor(NSString *dataURL) {
    NSRange comma = [dataURL rangeOfString:@","];
    if (comma.location == NSNotFound) return nil;
    NSData *data = [[NSData alloc] initWithBase64EncodedString:[dataURL substringFromIndex:comma.location + 1]
                                                       options:NSDataBase64DecodingIgnoreUnknownCharacters];
    NSImage *image = data ? [[NSImage alloc] initWithData:data] : nil;
    CGImageRef cg = image ? [image CGImageForProposedRect:NULL context:nil hints:nil] : NULL;
    if (!cg) return nil;
    uint8_t pixels[16 * 16 * 4] = {0};
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(pixels, 16, 16, 8, 16 * 4, space, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGContextDrawImage(context, CGRectMake(0, 0, 16, 16), cg);
    CGContextRelease(context);
    double r = 0, g = 0, b = 0, weight = 0;
    for (int i = 0; i < 16 * 16 * 4; i += 4) {
        double high = MAX(pixels[i], MAX(pixels[i + 1], pixels[i + 2]));
        double low = MIN(pixels[i], MIN(pixels[i + 1], pixels[i + 2]));
        double saturation = high > 0 ? (high - low) / high : 0;
        double w = saturation * saturation * (high / 255) + 0.01;
        r += pixels[i] * w;
        g += pixels[i + 1] * w;
        b += pixels[i + 2] * w;
        weight += w;
    }
    r /= weight; g /= weight; b /= weight;
    double top = MAX(r, MAX(g, b));
    if (top <= 0) return nil;
    double lift = top < 170 ? 170 / top : 1;
    return RGB(MIN(255, r * lift), MIN(255, g * lift), MIN(255, b * lift));
}

- (void)startAmbient {
    [self.nowPlaying start];
    if (!self.agentTimer) {
        __weak RelayNotchPanel *weakSelf = self;
        NSTimer *timer = [NSTimer timerWithTimeInterval:2.0 repeats:YES block:^(NSTimer *tick) { [weakSelf pollAgents]; }];
        timer.tolerance = 0.5;
        [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
        self.agentTimer = timer;
    }
    [self pollAgents];
}

- (void)stopAmbient {
    [self.agentTimer invalidate];
    self.agentTimer = nil;
    self.agentActor = nil;
    [self.nowPlaying stop];
    [self.glow hide];
}

// Asks the local engine (the same feed the panel page uses) whether an agent is working right now.
- (void)pollAgents {
    NSURL *url = [NSURL URLWithString:@"/api/notch" relativeToURL:self.pageURL].absoluteURL;
    if (!url) return;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.timeoutInterval = 3;
    request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    __weak RelayNotchPanel *weakSelf = self;
    [[NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSString *actor = nil;
        id parsed = (data && !error) ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSDictionary *run = [parsed isKindOfClass:NSDictionary.class] && [parsed[@"run"] isKindOfClass:NSDictionary.class] ? parsed[@"run"] : nil;
        if (run && [run[@"running"] boolValue] && ![run[@"paused"] boolValue]) {
            actor = [run[@"actor"] isKindOfClass:NSString.class] ? run[@"actor"] : @"relay";
        }
        if (!actor && [parsed isKindOfClass:NSDictionary.class]) {
            NSDictionary *desktop = [parsed[@"desktop"] isKindOfClass:NSDictionary.class] ? parsed[@"desktop"] : nil;
            NSArray *sessions = [desktop[@"sessions"] isKindOfClass:NSArray.class] ? desktop[@"sessions"] : @[];
            for (NSDictionary *session in sessions) {
                NSString *status = session[@"status"];
                if ([status isEqualToString:@"needs_approval"]) { actor = @"you"; break; }
                if ([status isEqualToString:@"working"]) actor = @"builder";
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            RelayNotchPanel *strongSelf = weakSelf;
            if (!strongSelf || !strongSelf.enabled) return;
            if ((strongSelf.agentActor == nil && actor == nil) || [strongSelf.agentActor isEqualToString:actor]) return;
            strongSelf.agentActor = actor;
            [strongSelf refreshGlow];
            if (actor) [strongSelf.glow burst]; // a new agent took over
        });
    }] resume];
}

// Agents at work come first (their colour), then music (the cover's colour). Nothing: no light.
- (void)refreshGlow {
    if (!self.enabled) {
        [self.glow hide];
        return;
    }
    if (self.agentActor) {
        [self.glow showAgentActor:self.agentActor];
    } else if ([self.nowPlaying.state[@"playing"] boolValue]) {
        [self.glow showMusicColor:self.musicColor ?: RGB(79, 181, 148)];
    } else {
        [self.glow hide];
    }
}

// Sends what is playing to the panel page. nil clears the music strip.
- (void)pushNowPlaying:(NSDictionary *)state {
    NSString *artwork = [state[@"artwork"] isKindOfClass:NSString.class] ? state[@"artwork"] : nil;
    if (![artwork isEqualToString:self.musicColorSource ?: @""]) {
        self.musicColorSource = artwork;
        self.musicColor = artwork ? DominantColor(artwork) : nil;
    }
    [self refreshGlow];
    NSString *script = @"if (!window.relayNowPlaying) return 'page has no handler yet';"
                        "window.relayNowPlaying(state);"
                        "return 'strip ' + (document.getElementById('panel').dataset.music ? 'shown' : 'hidden');";
    [self.webView callAsyncJavaScript:script
                            arguments:@{ @"state": state ?: NSNull.null }
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:^(id result, NSError *error) {
        [RelayNowPlaying log:[NSString stringWithFormat:@"page answered: %@", error ? [NSString stringWithFormat:@"FAILED %@", error] : result]];
    }];
}

// Tells the panel page which look of the light around the notch is saved, so its picker shows the choice.
- (void)pushGlowStyle {
    NSString *style = [NSUserDefaults.standardUserDefaults stringForKey:RelayGlowStyleKey] ?: @"line";
    [self.webView callAsyncJavaScript:@"if (window.relayGlowStyle) window.relayGlowStyle(style);"
                            arguments:@{ @"style": style }
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:nil];
}

- (void)playWelcome {
    [self.glow playWelcome];
}

#pragma mark - Window

- (void)buildWindow {
    _mode = RelayPanelModeCompact;
    _shownSize = NSMakeSize(CompactWidth, 26 + CompactBodyHeight);
    _contentSize = _shownSize;
    NSRect frame = NSMakeRect(0, 0, _shownSize.width, _shownSize.height);
    RelayNotchWindow *window = [[RelayNotchWindow alloc] initWithContentRect:frame
                                                                   styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                                     backing:NSBackingStoreBuffered
                                                                       defer:NO];
    window.releasedWhenClosed = NO;
    window.level = NSMainMenuWindowLevel + 2;
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    // The system shadow also draws a thin light rim along the top edge; the panel does not need either.
    window.hasShadow = NO;
    window.hidesOnDeactivate = NO;
    window.canHide = NO; // the panel stays even if Relay is hidden with Command-H
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                NSWindowCollectionBehaviorStationary |
                                NSWindowCollectionBehaviorFullScreenAuxiliary |
                                NSWindowCollectionBehaviorIgnoresCycle;

    // Round only the bottom corners so the panel looks like it hangs from the screen edge.
    NSView *container = [[NSView alloc] initWithFrame:frame];
    container.wantsLayer = YES;
    container.layer.backgroundColor = NSColor.blackColor.CGColor; // the same black as the notch itself
    container.layer.cornerRadius = PanelRadius;
    container.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
    container.layer.masksToBounds = YES;
    window.contentView = container;

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    RelayWeakMessageHandler *handler = [[RelayWeakMessageHandler alloc] init];
    handler.target = self;
    [configuration.userContentController addScriptMessageHandler:handler name:@"relayPanel"];
    RelayNotchWebView *webView = [[RelayNotchWebView alloc] initWithFrame:container.bounds configuration:configuration];
    __weak RelayNotchPanel *weakSelf = self;
    webView.fileDragHandler = ^(BOOL over) { [weakSelf pushDeliverDragState:over]; };
    webView.filesDropHandler = ^(NSArray<NSString *> *paths) { [weakSelf pushDeliverDrop:paths]; };
    // The page keeps the size of the current mode and stays pinned to the top while the window grows out of the notch.
    // layoutWebView places it on every frame, so it must not also resize itself.
    webView.autoresizingMask = NSViewNotSizable;
    webView.navigationDelegate = self;
    [webView setValue:@NO forKey:@"drawsBackground"];
    [container addSubview:webView];
    self.webView = webView;
    self.window = window;

    [webView loadRequest:[NSURLRequest requestWithURL:self.pageURL]];
}

- (void)buildCatcher {
    NSPanel *catcher = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 10, 10)
                                                  styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
    catcher.releasedWhenClosed = NO;
    catcher.level = NSMainMenuWindowLevel + 3;
    catcher.opaque = NO;
    catcher.hasShadow = NO;
    catcher.hidesOnDeactivate = NO;
    catcher.canHide = NO;
    // A window with nothing in it lets everything through, drags included; a hint of colour makes it a target.
    catcher.backgroundColor = [NSColor colorWithWhite:0 alpha:0.01];
    catcher.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                                 NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;
    RelayDragCatcherView *view = [[RelayDragCatcherView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    __weak RelayNotchPanel *weakSelf = self;
    view.fileDragArrived = ^{ [weakSelf openForFileDrag]; };
    catcher.contentView = view;
    self.catcher = catcher;
}

// A drag with files has reached the notch zone: the Deliver shelf opens under it.
- (void)openForFileDrag {
    if (!self.enabled || self.shown) return;
    self.pinned = NO;
    [self showOnScreen:[self screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModeCompact view:@"deliver"];
}

// The catcher is out only while the left button is held in the drag zone and the panel is closed.
- (void)updateDragCatcher {
    BOOL pressed = (NSEvent.pressedMouseButtons & 1) != 0;
    BOOL inZone = pressed && !self.shown && !self.draggingOut && [self pointerIsInDragZone];
    if (!inZone) {
        if (self.catcher.visible) [self.catcher orderOut:nil];
        return;
    }
    if (self.catcher.visible) return;
    NSScreen *screen = [self screenForPoint:NSEvent.mouseLocation];
    if (!screen) return;
    NSRect area = screen.frame;
    NSSize notch = [self notchSizeForScreen:screen];
    CGFloat width = notch.width + 2 * DragZoneMargin;
    CGFloat height = notch.height + DragZoneDepth;
    [self.catcher setFrame:NSMakeRect(NSMidX(area) - width / 2, NSMaxY(area) - height, width, height) display:NO];
    [self.catcher orderFrontRegardless];
}

- (NSScreen *)screenForPoint:(NSPoint)point {
    for (NSScreen *screen in NSScreen.screens) {
        // The pointer can sit exactly on the top edge, which NSPointInRect would treat as outside.
        NSRect frame = screen.frame;
        if (point.x >= NSMinX(frame) && point.x <= NSMaxX(frame) && point.y >= NSMinY(frame) && point.y <= NSMaxY(frame)) return screen;
    }
    return nil;
}

// The size of the physical notch, or a similar pill on Macs without one.
- (NSSize)notchSizeForScreen:(NSScreen *)screen {
    CGFloat width = 180, height = 26;
    if (@available(macOS 12.0, *)) {
        if (screen.safeAreaInsets.top > 0) {
            height = screen.safeAreaInsets.top;
            NSRect left = screen.auxiliaryTopLeftArea, right = screen.auxiliaryTopRightArea;
            if (!NSIsEmptyRect(left) && !NSIsEmptyRect(right) && NSMinX(right) > NSMaxX(left)) {
                width = NSMinX(right) - NSMaxX(left);
            }
        }
    }
    return NSMakeSize(width, height);
}

// progress 0 is exactly the notch; 1 is the open panel hanging from the top edge.
- (void)applyProgress:(CGFloat)progress {
    self.progress = progress;
    NSScreen *screen = self.screen ?: NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    if (!screen) return;
    NSRect area = screen.frame;
    NSSize notch = [self notchSizeForScreen:screen];
    CGFloat amount = MAX(0, progress);
    NSSize open = self.shownSize;
    CGFloat width = notch.width + (MAX(open.width, notch.width) - notch.width) * amount;
    CGFloat height = notch.height + (MAX(open.height, notch.height) - notch.height) * amount;
    NSRect frame = NSMakeRect(NSMidX(area) - width / 2, NSMaxY(area) - height, width, height);
    [self.window setFrame:frame display:YES];
    [self layoutWebView];
    CGFloat settled = MIN(1, amount);
    ((NSView *)self.window.contentView).layer.cornerRadius = 9 + (PanelRadius - 9) * settled;
    // The content appears once the panel is mostly open and goes first when it closes.
    self.webView.alphaValue = MIN(1, MAX(0, (settled - 0.5) / 0.4));
}

// The page always has the full size of the current mode, centered and pinned to the top of the clipped window.
- (void)layoutWebView {
    NSRect bounds = ((NSView *)self.window.contentView).bounds;
    NSSize size = self.contentSize; // the page is not re-laid-out on every frame of a resize
    NSRect frame = NSMakeRect(round((NSWidth(bounds) - size.width) / 2), NSHeight(bounds) - size.height, size.width, size.height);
    if (!NSEqualRects(self.webView.frame, frame)) self.webView.frame = frame;
}

- (NSSize)sizeForMode:(RelayPanelMode)mode screen:(NSScreen *)screen {
    CGFloat band = [self notchSizeForScreen:screen].height;
    switch (mode) {
        case RelayPanelModePill: return NSMakeSize(PillWidth, band + PillBodyHeight);
        case RelayPanelModeCompact: {
            // Usually the same height. The Translate page grows it to hold a long result, up to a share of the screen.
            CGFloat limit = MAX(CompactBodyHeight, NSHeight(screen.visibleFrame) * FitMaxScreenShare - band);
            CGFloat body = self.fitHeight > CompactBodyHeight ? MIN(self.fitHeight, limit) : CompactBodyHeight;
            return NSMakeSize(CompactWidth, band + body);
        }
        case RelayPanelModeFull: return self.cardSize ? NSMakeSize(CardWidth, band + CardBodyHeight) : NSMakeSize(FullWidth, band + FullBodyHeight);
    }
    return NSMakeSize(CompactWidth, band + CompactBodyHeight);
}

- (NSScreen *)activeScreen {
    return self.screen ?: NSScreen.mainScreen ?: NSScreen.screens.firstObject;
}

// Tells the page which shape it has, how big the notch is, and optionally which view to show.
- (void)pushMode {
    NSScreen *screen = [self activeScreen];
    if (!screen) return;
    NSSize notch = [self notchSizeForScreen:screen];
    NSArray *names = @[ @"pill", @"compact", @"full" ];
    NSDictionary *info = @{ @"mode": names[self.mode], @"notchWidth": @(round(notch.width)), @"notchHeight": @(round(notch.height)),
                            @"view": self.modeView ?: NSNull.null, @"card": @(self.cardSize && self.mode == RelayPanelModeFull) };
    NSString *script = @"if (!window.relayPanelMode) return 'page has no mode handler yet'; window.relayPanelMode(info); return 'ok';";
    [self.webView callAsyncJavaScript:script
                            arguments:@{ @"info": info }
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:^(id result, NSError *error) {
        if (error || ![result isEqual:@"ok"]) [RelayNowPlaying log:[NSString stringWithFormat:@"mode push: %@", error ? [NSString stringWithFormat:@"FAILED %@", error] : result]];
    }];
}

// The Translate page has a result that is taller than the small panel (or no longer has one): the panel grows downward to hold it,
// or goes back to its usual size when the height is 0. Only the small panel changes; the page scrolls beyond the limit.
- (void)fitBodyHeight:(CGFloat)height {
    if (!isfinite(height) || height < 0) height = 0;
    height = MIN(height, 4000);
    if (height == self.fitHeight) return;
    self.fitHeight = height;
    if (!self.shown || self.mode != RelayPanelModeCompact) return;
    NSScreen *screen = [self activeScreen];
    if (!screen) return;
    NSSize target = [self sizeForMode:self.mode screen:screen];
    if (NSEqualSizes(target, self.contentSize)) return;
    self.contentSize = target;
    BOOL settled = self.progress >= 1 && !self.frameTimer;
    if (settled) {
        [self animateSizeTo:target duration:0.22];
        return;
    }
    [self.sizeTimer invalidate];
    self.sizeTimer = nil;
    self.shownSize = target;
    if (!self.frameTimer) [self applyProgress:self.progress];
}

// Changes the shape. A panel that is already open grows or shrinks smoothly; one that is opening just aims at the new size.
- (void)changeMode:(RelayPanelMode)mode view:(NSString *)view {
    BOOL changed = mode != self.mode || self.cardSize != self.laidOutCard;
    if (mode != self.mode) self.fitHeight = 0; // the Translate page asks again when it is back in the small panel
    self.laidOutCard = self.cardSize;
    self.mode = mode;
    self.modeView = view;
    NSScreen *screen = [self activeScreen];
    if (!screen) return;
    NSSize target = [self sizeForMode:mode screen:screen];
    self.contentSize = target;
    [self pushMode];
    BOOL settled = self.shown && self.progress >= 1 && !self.frameTimer;
    if (settled && changed) {
        [self animateSizeTo:target duration:0.32];
        return;
    }
    [self.sizeTimer invalidate];
    self.sizeTimer = nil;
    self.shownSize = target;
    if (self.shown && !self.frameTimer) [self applyProgress:self.progress];
}

- (void)animateSizeTo:(NSSize)target duration:(NSTimeInterval)duration {
    [self.sizeTimer invalidate];
    self.sizeTimer = nil;
    NSSize start = self.shownSize;
    if (duration <= 0 || NSEqualSizes(start, target)) {
        self.shownSize = target;
        [self applyProgress:self.progress];
        return;
    }
    NSDate *began = [NSDate date];
    __weak RelayNotchPanel *weakSelf = self;
    NSTimer *timer = [NSTimer timerWithTimeInterval:1.0 / 120 repeats:YES block:^(NSTimer *tick) {
        RelayNotchPanel *strongSelf = weakSelf;
        if (!strongSelf) { [tick invalidate]; return; }
        CGFloat t = MIN(1, -[began timeIntervalSinceNow] / duration);
        CGFloat eased = 1 - pow(1 - t, 3);
        strongSelf.shownSize = NSMakeSize(start.width + (target.width - start.width) * eased,
                                          start.height + (target.height - start.height) * eased);
        if (t >= 1) {
            [tick invalidate];
            strongSelf.sizeTimer = nil;
            strongSelf.shownSize = target;
        }
        [strongSelf applyProgress:strongSelf.progress];
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
    self.sizeTimer = timer;
}

- (void)animateToProgress:(CGFloat)target duration:(NSTimeInterval)duration completion:(void (^)(void))completion {
    [self.frameTimer invalidate];
    CGFloat start = self.progress;
    if (duration <= 0 || start == target) {
        [self applyProgress:target];
        if (completion) completion();
        return;
    }
    NSDate *began = [NSDate date];
    __weak RelayNotchPanel *weakSelf = self;
    NSTimer *timer = [NSTimer timerWithTimeInterval:1.0 / 120 repeats:YES block:^(NSTimer *tick) {
        RelayNotchPanel *strongSelf = weakSelf;
        if (!strongSelf) { [tick invalidate]; return; }
        CGFloat t = MIN(1, -[began timeIntervalSinceNow] / duration);
        // No overshoot: opening eases out and closing eases in and out, so the motion stays smooth.
        CGFloat eased = target > start ? 1 - pow(1 - t, 4) : t * t * (3 - 2 * t);
        [strongSelf applyProgress:start + (target - start) * eased];
        if (t >= 1) {
            [tick invalidate];
            strongSelf.frameTimer = nil;
            [strongSelf applyProgress:target];
            if (completion) completion();
        }
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
    self.frameTimer = timer;
}

#pragma mark - Showing and hiding

// Opens in the given shape, or grows an open panel to it. A panel never shrinks because something else asked.
- (void)showOnScreen:(NSScreen *)screen mode:(RelayPanelMode)mode view:(NSString *)view {
    if (!screen) screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    if (!screen) return;
    [self cancelTimer:&_hideTimer];
    self.screen = screen;
    if (!self.shown) {
        self.shown = YES;
        self.hovered = NO;
        [self.sizeTimer invalidate];
        self.sizeTimer = nil;
        self.progress = 0;
        [self changeMode:mode view:view];
        [self applyProgress:0];
        [self.window orderFrontRegardless];
        [self animateToProgress:1 duration:mode == RelayPanelModePill ? 0.4 : 0.5 completion:nil];
        return;
    }
    if (mode > self.mode || (view && mode == self.mode && !self.holding)) [self changeMode:MAX(mode, self.mode) view:view];
    if (self.progress < 1 && !self.frameTimer) {
        [self animateToProgress:1 duration:0.3 completion:nil];
    } else if (!self.frameTimer && !self.sizeTimer) {
        [self applyProgress:1];
    }
}

- (void)hideAnimated:(BOOL)animated {
    [self.dictation cancel]; // the panel is going away: nothing is listening to the person any more
    [self cancelTimer:&_showTimer];
    [self cancelTimer:&_hideTimer];
    [self cancelTimer:&_doneTimer];
    [self cancelTimer:&_pillTimer];
    [self.sizeTimer invalidate];
    self.sizeTimer = nil;
    self.pinned = NO;
    self.sticky = NO;
    self.hovered = NO;
    self.holding = NO;
    if (!self.shown) return;
    self.shown = NO;
    self.cardSize = NO; // the next full panel is a full one unless a card asks otherwise
    self.fitHeight = 0; // and a small one starts at its usual height
    __weak RelayNotchPanel *weakSelf = self;
    [self animateToProgress:0 duration:animated ? 0.32 : 0 completion:^{
        // A new show request may have started while this was running.
        RelayNotchPanel *strongSelf = weakSelf;
        if (strongSelf && !strongSelf.shown) [strongSelf.window orderOut:nil];
    }];
}

// The full panel is either the big one or the small one that holds only a spoken request's card. Anything else that needs the full
// panel (the Office, a plan to approve) asks for the big one, and a panel that is open in the other size changes size.
- (void)useCardSize:(BOOL)card {
    if (self.cardSize == card) return;
    self.cardSize = card;
    if (self.shown && self.mode == RelayPanelModeFull) [self changeMode:RelayPanelModeFull view:self.modeView];
}

// Double-tap right Command: open the full panel on the Office, or close it when it is already full.
- (void)toggle {
    if (self.shown && self.mode == RelayPanelModeFull) {
        [self hideAnimated:YES];
        return;
    }
    [self cancelTimer:&_doneTimer];
    [self cancelTimer:&_pillTimer];
    self.pinned = YES;
    self.sticky = YES;
    [self useCardSize:NO];
    [self showOnScreen:[self screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModeFull view:@"office"];
    // Opened on purpose from the keyboard: take the keys so Escape works at once.
    [self.window makeKeyWindow];
    [self.window makeFirstResponder:self.webView];
}

// Something needs the person (a plan to approve): the full panel, kept until they have looked at it.
- (void)showPinned {
    if (!self.enabled) return;
    [self cancelTimer:&_doneTimer];
    [self cancelTimer:&_pillTimer];
    self.pinned = YES;
    [self useCardSize:NO];
    [self showOnScreen:[self screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModeFull view:nil];
}

// A task finished or failed: peek in for a few seconds, then leave unless the pointer is on the panel.
- (void)peek {
    [self peekView:@"task" seconds:DoneVisibleSeconds];
}

// A note's reminder time has come: the small panel opens on the Notes, with the reminder banner, and stays a little longer.
- (void)peekReminder {
    [self peekView:@"notes" seconds:ReminderVisibleSeconds];
}

- (void)peekView:(NSString *)view seconds:(NSTimeInterval)seconds {
    if (!self.enabled) return;
    [self cancelTimer:&_pillTimer];
    [self showOnScreen:[self screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModeCompact view:view];
    [self cancelTimer:&_doneTimer];
    __weak RelayNotchPanel *weakSelf = self;
    self.doneTimer = [NSTimer scheduledTimerWithTimeInterval:seconds repeats:NO block:^(NSTimer *timer) {
        RelayNotchPanel *strongSelf = weakSelf;
        if (!strongSelf || strongSelf.pinned || strongSelf.holding) return;
        if (![strongSelf pointerIsNearPanel]) [strongSelf hideAnimated:YES];
    }];
}

// The track changed: the notch grows into a small pill for a few seconds. It never interrupts an open panel.
- (void)showTrackPill {
    if (!self.enabled || self.shown) return;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (now - self.lastPillAt < PillMinGap) return;
    self.lastPillAt = now;
    self.pinned = NO;
    self.sticky = NO;
    [self showOnScreen:[self screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModePill view:nil];
    [self cancelTimer:&_pillTimer];
    __weak RelayNotchPanel *weakSelf = self;
    self.pillTimer = [NSTimer scheduledTimerWithTimeInterval:PillVisibleSeconds repeats:NO block:^(NSTimer *timer) {
        RelayNotchPanel *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf.pillTimer = nil;
        if (strongSelf.shown && strongSelf.mode == RelayPanelModePill) [strongSelf hideAnimated:YES];
    }];
}

#pragma mark - Deliver

// Calls a function of the panel page, if the page has defined it.
- (void)callPage:(NSString *)script arguments:(NSDictionary *)arguments {
    [self.webView callAsyncJavaScript:script
                            arguments:arguments
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:nil];
}

- (void)pushDeliverDragState:(BOOL)over {
    [self callPage:@"if (window.relayDeliverDragState) window.relayDeliverDragState(over);" arguments:@{ @"over": @(over) }];
}

// Files were dropped on the panel: the page puts them on the Deliver shelf.
- (void)pushDeliverDrop:(NSArray<NSString *> *)paths {
    [self callPage:@"if (window.relayDeliverDrop) window.relayDeliverDrop(paths);" arguments:@{ @"paths": paths }];
}

// True while the person drags files from Finder or another app. Nothing in a drag tells us what it carries until it
// starts, so this watches the drag board: while no button is down its change count is noted, and a count that has
// changed with the left button down means a drag began, which counts when it carries files.
- (BOOL)fileDragInProgress {
    NSPasteboard *board = [NSPasteboard pasteboardWithName:NSPasteboardNameDrag];
    if (!(NSEvent.pressedMouseButtons & 1)) {
        self.dragBoardCount = board.changeCount;
        return NO;
    }
    if (board.changeCount == self.dragBoardCount) return NO;
    return CarriesFiles(board.types);
}

// A Deliver row was pressed and the pointer has moved with the button still down: drag the files out.
- (void)checkDragOut {
    if (!self.armedPaths) return;
    if (!(NSEvent.pressedMouseButtons & 1)) { // released: it was a click
        self.armedPaths = nil;
        return;
    }
    NSPoint here = NSEvent.mouseLocation;
    if (hypot(here.x - self.armedAt.x, here.y - self.armedAt.y) < 5) return;
    NSArray<NSString *> *paths = self.armedPaths;
    self.armedPaths = nil;
    [self beginDragOutOfPaths:paths];
}

- (void)beginDragOutOfPaths:(NSArray<NSString *> *)paths {
    if (!self.shown || self.draggingOut) return;
    // The drag starts from where the pointer is now.
    NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                        location:[self.window convertPointFromScreen:NSEvent.mouseLocation]
                                   modifierFlags:0
                                       timestamp:NSProcessInfo.processInfo.systemUptime
                                    windowNumber:self.window.windowNumber
                                         context:nil
                                     eventNumber:0
                                      clickCount:1
                                        pressure:1.0];
    if (!event) return;
    NSPoint local = [self.webView convertPoint:event.locationInWindow fromView:nil];
    NSMutableArray<NSDraggingItem *> *items = [NSMutableArray array];
    for (NSString *path in paths) {
        if (![NSFileManager.defaultManager fileExistsAtPath:path]) continue; // moved or deleted since it was dropped
        NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:[NSURL fileURLWithPath:path]];
        NSImage *icon = [[NSWorkspace.sharedWorkspace iconForFile:path] copy];
        icon.size = NSMakeSize(44, 44);
        [item setDraggingFrame:NSMakeRect(local.x - 22, local.y - 22, 44, 44) contents:icon];
        [items addObject:item];
    }
    if (!items.count) return;
    self.draggingOut = YES;
    self.dragOutIdleTicks = 0;
    [self cancelTimer:&_hideTimer];
    NSDraggingSession *session = [self.webView beginDraggingSessionWithItems:items event:event source:self];
    session.draggingFormation = NSDraggingFormationPile;
    session.animatesToStartingPositionsOnCancelOrFail = YES;
}

#pragma mark - NSDraggingSource

// The files may be dropped in any other app (copied, or moved when the target moves them), but not back into the panel.
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return context == NSDraggingContextOutsideApplication ? (NSDragOperationCopy | NSDragOperationMove | NSDragOperationGeneric) : NSDragOperationNone;
}

- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)screenPoint operation:(NSDragOperation)operation {
    self.draggingOut = NO;
    // The page takes the files off the shelf when they were moved, or when the person wants them off after a drop.
    [self callPage:@"if (window.relayDeliverDragEnded) window.relayDeliverDragEnded(accepted, moved);"
         arguments:@{ @"accepted": @(operation != NSDragOperationNone), @"moved": @((operation & NSDragOperationMove) != 0) }];
}

#pragma mark - Pointer tracking

// The pointer and modifier keys are read 40 times a second. This works in every app and Space,
// needs no special permission, and also catches the very top pixel row that event monitors can miss.
- (void)installMonitors {
    if (self.pollTimer) return;
    __weak RelayNotchPanel *weakSelf = self;
    // Without this, macOS slows timers right down once Relay is not the front app, and the hover and the
    // double Command tap stop responding anywhere except in Relay itself.
    self.activity = [NSProcessInfo.processInfo beginActivityWithOptions:(NSActivityUserInitiated | NSActivityLatencyCritical)
                                                                  reason:@"Watching the pointer and the Command key for the notch panel"];
    // Pointer events from other apps need no special permission, and they also wake the app if it was napping.
    self.mouseMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskMouseMoved
                                                               handler:^(NSEvent *event) { [weakSelf pointerMoved]; }];
    NSTimer *timer = [NSTimer timerWithTimeInterval:0.025 repeats:YES block:^(NSTimer *tick) {
        [weakSelf pointerMoved];
    }];
    timer.tolerance = 0.005;
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
    self.pollTimer = timer;
}

- (void)removeMonitors {
    if (self.mouseMonitor) [NSEvent removeMonitor:self.mouseMonitor];
    self.mouseMonitor = nil;
    if (self.activity) [NSProcessInfo.processInfo endActivity:self.activity];
    self.activity = nil;
    [self.pollTimer invalidate];
    self.pollTimer = nil;
    [self cancelTimer:&_showTimer];
}

- (BOOL)pointerIsNearPanel {
    return NSPointInRect(NSEvent.mouseLocation, NSInsetRect(self.window.frame, -14, -14));
}

- (BOOL)pointerIsInHotZone {
    NSPoint point = NSEvent.mouseLocation;
    NSScreen *screen = [self screenForPoint:point];
    if (!screen) return NO;
    NSRect area = screen.frame;
    // The hot zone is the whole menu bar band around the notch, not only the top pixel row.
    NSSize notch = [self notchSizeForScreen:screen];
    CGFloat half = notch.width / 2 + TriggerMargin;
    return point.y >= NSMaxY(area) - (notch.height + 4) && fabs(point.x - NSMidX(area)) <= half;
}

// While files are dragged the pointer holds the file by its icon, which hangs below and beside it, so a person who
// "moves the file to the notch" has the pointer well below the menu bar band. The zone is much larger then.
- (BOOL)pointerIsInDragZone {
    NSPoint point = NSEvent.mouseLocation;
    NSScreen *screen = [self screenForPoint:point];
    if (!screen) return NO;
    NSRect area = screen.frame;
    NSSize notch = [self notchSizeForScreen:screen];
    return point.y >= NSMaxY(area) - (notch.height + DragZoneDepth) && fabs(point.x - NSMidX(area)) <= notch.width / 2 + DragZoneMargin;
}

// Hold the right Option key (on its own, for a third of a second) to talk: the panel opens on the Notes, the microphone
// listens while the key is down, and the words appear in the note field. Read the same way as the Command taps.
- (void)checkVoiceKey {
    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    CGEventFlags others = kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskCommand;
    BOOL rightDown = (flags & RightOptionMask) != 0;
    BOOL clean = rightDown && !(flags & LeftOptionMask) && !(flags & others);
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (rightDown && !self.optionDown) {
        self.optionDown = YES;
        self.optionPressedAt = now;
        self.optionValid = clean;
        self.voiceKeyActive = NO;
        return;
    }
    if (rightDown) {
        if (!clean) self.optionValid = NO;
        CFTimeInterval held = now - self.optionPressedAt;
        if (self.optionValid && !self.voiceKeyActive && held >= VoiceKeyHold) {
            // Option with a letter types a special character, and with a click it is a shortcut: neither is "talk".
            CFTimeInterval sinceKey = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventKeyDown);
            CFTimeInterval sinceClick = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventLeftMouseDown);
            if (sinceKey > held + 0.05 && sinceClick > held + 0.05) {
                self.voiceKeyActive = YES;
                [self voiceKeyChanged:YES];
            } else {
                self.optionValid = NO;
            }
        }
        return;
    }
    if (!self.optionDown) return;
    self.optionDown = NO;
    if (self.voiceKeyActive) {
        self.voiceKeyActive = NO;
        [self voiceKeyChanged:NO];
    }
}

- (void)voiceKeyChanged:(BOOL)down {
    if (!self.enabled) return;
    if (down) [self peekView:@"notes" seconds:VoiceVisibleSeconds];
    [self callPage:@"if (window.relayVoiceKey) window.relayVoiceKey(down);" arguments:@{ @"down": @(down) }];
}

// Double-tap the right Command key to open or close the panel. The key state is read directly,
// so this works in every app without asking for Input Monitoring or Accessibility access.
- (void)checkCommandTaps {
    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    CGEventFlags others = kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate;
    BOOL rightDown = (flags & RightCommandMask) != 0;
    BOOL clean = rightDown && !(flags & LeftCommandMask) && !(flags & others);
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();

    if (rightDown && !self.commandDown) {
        self.commandDown = YES;
        self.commandPressedAt = now;
        self.commandTapValid = clean;
        return;
    }
    if (rightDown) {
        if (!clean) self.commandTapValid = NO;
        return;
    }
    if (!self.commandDown) return;

    // Released.
    self.commandDown = NO;
    CFTimeInterval held = now - self.commandPressedAt;
    // Command with a key or a click (for example Command-C) is a shortcut, not a tap.
    CFTimeInterval sinceKey = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventKeyDown);
    CFTimeInterval sinceClick = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventLeftMouseDown);
    BOOL usedWithOtherInput = sinceKey < held + 0.05 || sinceClick < held + 0.05;
    if (!self.commandTapValid || held > TapMaxHold || usedWithOtherInput) {
        self.lastTapAt = 0;
        return;
    }
    if (self.lastTapAt > 0 && now - self.lastTapAt <= DoubleTapWindow) {
        self.lastTapAt = 0;
        [self toggle];
    } else {
        self.lastTapAt = now;
    }
}

- (void)pointerMoved {
    [self checkCommandTaps];
    [self checkVoiceKey];
    if (!self.enabled) return;
    [self checkDragOut];
    if (self.draggingOut) { // the panel stays while its files are being carried away
        // If the system never reported the end of the drag, the button being up for a while is the end of it.
        // Without this, one lost report would keep the panel from ever opening again.
        self.dragOutIdleTicks = (NSEvent.pressedMouseButtons & 1) ? 0 : self.dragOutIdleTicks + 1;
        if (self.dragOutIdleTicks > 40) {
            [RelayNowPlaying log:@"deliver: the end of a drag out was never reported; carrying on"];
            self.draggingOut = NO;
        } else {
            [self cancelTimer:&_hideTimer];
            return;
        }
    }
    BOOL fileDrag = [self fileDragInProgress];
    [self updateDragCatcher];
    if (self.shown) {
        if ([self pointerIsNearPanel]) {
            self.hovered = YES;
            [self cancelTimer:&_hideTimer];
            if (self.mode == RelayPanelModePill) {
                // The pointer reached the pill: it becomes the compact panel, on the music.
                [self cancelTimer:&_pillTimer];
                [self changeMode:RelayPanelModeCompact view:@"music"];
            }
            return;
        }
        if (self.mode == RelayPanelModePill) return; // retracts by its own timer
        if (self.holding) {
            [self cancelTimer:&_hideTimer];
            return;
        }
        // Opened with the keyboard: it stays until the same shortcut, Escape, or Open Relay.
        if (self.sticky) return;
        // Opened because something needs the person: wait until they have looked at it.
        if (self.pinned && !self.hovered) return;
        [self scheduleHide];
        return;
    }
    // Ignore the pointer while dragging, for example when moving a window to the top of the screen.
    // Files being dragged are the exception: the Deliver shelf opens so they can be dropped on it.
    if ((fileDrag ? [self pointerIsInDragZone] : [self pointerIsInHotZone]) && (NSEvent.pressedMouseButtons == 0 || fileDrag)) {
        [self scheduleShow];
    } else {
        [self cancelTimer:&_showTimer];
    }
}

- (void)scheduleShow {
    if (self.showTimer) return;
    __weak RelayNotchPanel *weakSelf = self;
    self.showTimer = [NSTimer scheduledTimerWithTimeInterval:ShowDelay repeats:NO block:^(NSTimer *timer) {
        RelayNotchPanel *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf.showTimer = nil;
        BOOL dragging = [strongSelf fileDragInProgress];
        if (strongSelf.enabled && !strongSelf.shown && (dragging ? [strongSelf pointerIsInDragZone] : [strongSelf pointerIsInHotZone])) {
            strongSelf.pinned = NO;
            if (dragging) {
                [strongSelf showOnScreen:[strongSelf screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModeCompact view:@"deliver"];
            } else {
                [strongSelf showOnScreen:[strongSelf screenForPoint:NSEvent.mouseLocation] mode:RelayPanelModeCompact view:nil];
            }
        }
    }];
}

- (void)scheduleHide {
    if (self.hideTimer) return;
    __weak RelayNotchPanel *weakSelf = self;
    self.hideTimer = [NSTimer scheduledTimerWithTimeInterval:HideDelay repeats:NO block:^(NSTimer *timer) {
        RelayNotchPanel *strongSelf = weakSelf;
        if (!strongSelf) return;
        strongSelf.hideTimer = nil;
        if (!strongSelf.holding && ![strongSelf pointerIsNearPanel]) [strongSelf hideAnimated:YES];
    }];
}

- (void)cancelTimer:(NSTimer *__strong *)timer {
    [*timer invalidate];
    *timer = nil;
}

#pragma mark - Messages from the panel page

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    // Only Relay's own page, served by the local engine, may talk to the app.
    NSURL *origin = message.frameInfo.request.URL;
    if (!message.frameInfo.isMainFrame ||
        ![origin.host isEqualToString:self.pageURL.host] ||
        ![origin.port isEqualToNumber:self.pageURL.port]) return;
    if (![message.body isKindOfClass:NSDictionary.class]) return;
    NSDictionary *body = message.body;
    NSString *type = [body[@"type"] isKindOfClass:NSString.class] ? body[@"type"] : @"";

    if ([type isEqualToString:@"open"]) {
        NSString *runID = [body[@"runId"] isKindOfClass:NSString.class] ? body[@"runId"] : nil;
        if (runID.length > 0 && runID.length <= 128) {
            NSString *tab = [@[@"feed", @"changes", @"findings"] containsObject:body[@"tab"]] ? body[@"tab"] : @"feed";
            NSString *step = [@[@"inspect", @"clarify", @"approve", @"build", @"review", @"refine", @"result"] containsObject:body[@"step"]] ? body[@"step"] : @"result";
            [self.delegate notchPanelRequestsOpenRelayAt:@{@"run": runID, @"tab": tab, @"step": step}];
        } else {
            [self.delegate notchPanelRequestsOpenRelay];
        }
        [self hideAnimated:YES];
    } else if ([type isEqualToString:@"open-provider"]) {
        NSString *provider = body[@"provider"];
        NSString *bundleID = [provider isEqualToString:@"codex"] ? @"com.openai.codex" : [provider isEqualToString:@"claude"] ? @"com.anthropic.claudefordesktop" : nil;
        NSURL *url = bundleID ? [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:bundleID] : nil;
        if (url) [NSWorkspace.sharedWorkspace openApplicationAtURL:url configuration:NSWorkspaceOpenConfiguration.configuration completionHandler:nil];
    } else if ([type isEqualToString:@"quit"]) {
        // Quit goes through the app, which waits for the engine to save a running task before it exits.
        [self hideAnimated:YES];
        [self.delegate notchPanelRequestsQuit];
    } else if ([type isEqualToString:@"hide"]) {
        [self hideAnimated:YES];
    } else if ([type isEqualToString:@"reminder"]) {
        [self peekReminder];
    } else if ([type isEqualToString:@"attention"]) {
        if ([body[@"keep"] boolValue]) [self showPinned];
        else [self peek];
    } else if ([type isEqualToString:@"ready"]) {
        // The page has just loaded and can now show its shape and what is playing.
        [RelayNowPlaying log:@"page is ready"];
        if (self.shown) [self pushMode];
        if (self.nowPlaying.state) [self pushNowPlaying:self.nowPlaying.state];
        [self pushGlowStyle];
    } else if ([type isEqualToString:@"glowStyle"]) {
        // The person picked how the light around the notch looks (Customize, On screen).
        NSString *style = [body[@"style"] isKindOfClass:NSString.class] ? body[@"style"] : @"";
        if ([@[ @"off", @"line", @"halo", @"sparks" ] containsObject:style]) {
            [NSUserDefaults.standardUserDefaults setObject:style forKey:RelayGlowStyleKey];
            self.glow.style = style;
        }
    } else if ([type isEqualToString:@"expand"]) {
        // The small panel needs room: a plan to approve, or the person pressed the Office tab.
        NSString *view = [body[@"view"] isEqual:@"office"] ? @"office" : nil;
        if (self.shown) {
            [self cancelTimer:&_pillTimer];
            [self useCardSize:!view && [body[@"card"] boolValue]]; // a spoken request's card needs a wide panel, not a tall one
            [self showOnScreen:self.screen mode:RelayPanelModeFull view:view];
            // Pressed on purpose: take the keys so Escape closes it. It still closes when the pointer leaves.
            if (view) {
                [self.window makeKeyWindow];
                [self.window makeFirstResponder:self.webView];
            }
        }
    } else if ([type isEqualToString:@"fit"]) {
        // The Translate page: the height it needs below the notch band, or 0 to go back to the usual size.
        id wanted = body[@"height"];
        [self fitBodyHeight:[wanted isKindOfClass:NSNumber.class] ? [wanted doubleValue] : 0];
    } else if ([type isEqualToString:@"clipboard"]) {
        // The Paste button on the Translate page. The clipboard is read only when the person presses it, never in the background.
        NSString *text = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
        if (![text isKindOfClass:NSString.class]) text = @"";
        text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (text.length > ClipboardMaxLength) {
            NSRange range = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, ClipboardMaxLength)];
            text = [text substringWithRange:range];
        }
        [self.webView callAsyncJavaScript:@"if (window.relayClipboard) window.relayClipboard(text); return 'ok';"
                                arguments:@{ @"text": text }
                                  inFrame:nil
                           inContentWorld:WKContentWorld.pageWorld
                        completionHandler:nil];
    } else if ([type isEqualToString:@"copy"]) {
        // The Copy button on the Translate page puts the translation on the clipboard.
        NSString *text = [body[@"text"] isKindOfClass:NSString.class] ? body[@"text"] : @"";
        if (text.length > 0 && text.length <= 20000) {
            [NSPasteboard.generalPasteboard clearContents];
            [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString];
        }
    } else if ([type isEqualToString:@"shrink"]) {
        // The person left the Office (or the plan) for a view that fits the small panel.
        if (self.shown && self.mode == RelayPanelModeFull) {
            [self cancelTimer:&_doneTimer];
            self.sticky = NO;
            self.pinned = NO;
            self.hovered = YES;
            [self changeMode:RelayPanelModeCompact view:nil];
        }
    } else if ([type isEqualToString:@"media"]) {
        [self.nowPlaying sendCommand:body[@"command"]];
    } else if ([type isEqualToString:@"deliverArm"]) {
        // A file row on the Deliver shelf was pressed. If the pointer now moves with the button down, those files are dragged out.
        NSMutableArray<NSString *> *paths = [NSMutableArray array];
        NSArray *given = [body[@"paths"] isKindOfClass:NSArray.class] ? body[@"paths"] : @[];
        for (id path in given) {
            if ([path isKindOfClass:NSString.class] && [path hasPrefix:@"/"] && paths.count < 100) [paths addObject:path];
        }
        self.armedPaths = paths.count ? paths : nil;
        self.armedAt = NSEvent.mouseLocation;
    } else if ([type isEqualToString:@"hold"]) {
        // The note field has the keyboard: keep the panel open until typing stops or Escape.
        self.holding = [body[@"on"] boolValue];
        if (self.holding) {
            [self cancelTimer:&_hideTimer];
            [self.window makeKeyWindow];
        }
    } else if ([type isEqualToString:@"dictate"]) {
        // The microphone button, or the page answering the right Option key: listen, finish, or throw away.
        NSString *action = [body[@"action"] isKindOfClass:NSString.class] ? body[@"action"] : @"";
        if ([action isEqualToString:@"start"]) {
            NSString *locale = [body[@"locale"] isKindOfClass:NSString.class] ? body[@"locale"] : @"en-US";
            if (![@[ @"en-US", @"ru-RU" ] containsObject:locale]) locale = @"en-US";
            if (!self.dictation) {
                self.dictation = [[RelayDictation alloc] init];
                self.dictation.delegate = self;
            }
            self.wakeDictating = YES;
            [self updateWakePause];
            [self.speech stop]; // the person is talking now: the answer stops (and the microphone does not hear it)
            [self.dictation startWithLocale:locale];
        } else if ([action isEqualToString:@"stop"]) {
            [self.dictation stop];
        } else if ([action isEqualToString:@"cancel"]) {
            [self.dictation cancel];
        }
    } else if ([type isEqualToString:@"wake"]) {
        // "Hey Relay" turned on or off in the Relay window (the page tells us when it loads and whenever the choice changes).
        NSString *locale = [body[@"locale"] isKindOfClass:NSString.class] ? body[@"locale"] : @"en-US";
        if (![@[ @"en-US", @"ru-RU" ] containsObject:locale]) locale = @"en-US";
        if ([body[@"on"] boolValue]) {
            if (!self.wake) {
                self.wake = [[RelayWake alloc] init];
                self.wake.delegate = self;
            }
            [self.wake startWithLocale:locale];
            [self updateWakePause];
        } else {
            [self.wake stop];
        }
    } else if ([type isEqualToString:@"speak"]) {
        // An answer to say out loud (or "stop"). The voice carries on if the panel hides: the answer is for the person, not the panel.
        if ([body[@"action"] isEqual:@"stop"]) {
            [self.speech stop];
        } else {
            NSString *locale = [body[@"locale"] isKindOfClass:NSString.class] ? body[@"locale"] : @"en-US";
            if (![@[ @"en-US", @"ru-RU" ] containsObject:locale]) locale = @"en-US";
            if (!self.speech) {
                self.speech = [[RelaySpeech alloc] init];
                self.speech.delegate = self;
            }
            self.wakeSpeaking = YES; // the wake word listener does not listen while the Mac talks
            [self updateWakePause];
            [self.speech speak:body[@"text"] locale:locale];
        }
    } else if ([type isEqualToString:@"app"]) {
        // "open Safari": the names the page thinks the app may have (the first one that is installed is opened).
        NSMutableArray<NSString *> *names = [NSMutableArray array];
        for (id name in ([body[@"names"] isKindOfClass:NSArray.class] ? body[@"names"] : @[])) {
            if ([name isKindOfClass:NSString.class] && [name length] > 0 && [name length] <= 60 && names.count < 4) [names addObject:name];
        }
        __weak typeof(self) weakSelf = self;
        [RelayActions openApplicationNames:names done:^(NSString *state, NSString *detail) {
            [weakSelf reportAction:@"app" state:state detail:detail];
            if ([state isEqualToString:@"opened"]) [weakSelf hideAnimated:YES]; // the app is in front now
        }];
    } else if ([type isEqualToString:@"front"]) {
        // Which app would "type …" go to? Asked when the words are shown, so that the person sees where they will land.
        self.typeTarget = [RelayActions workingApplication];
        [self reportAction:@"front" state:self.typeTarget ? @"ok" : @"none" detail:self.typeTarget.localizedName ?: @""];
    } else if ([type isEqualToString:@"type"]) {
        NSString *text = [body[@"text"] isKindOfClass:NSString.class] ? body[@"text"] : @"";
        if (text.length == 0 || text.length > 2000) return;
        __weak typeof(self) weakSelf = self;
        [RelayActions typeText:text into:self.typeTarget prepare:^{ [weakSelf hideAnimated:YES]; } done:^(NSString *state, NSString *detail) {
            [weakSelf reportAction:@"type" state:state detail:detail];
        }];
    } else if ([type isEqualToString:@"telegram"]) {
        NSString *text = [body[@"text"] isKindOfClass:NSString.class] ? body[@"text"] : @"";
        if (text.length == 0 || text.length > 2000) return;
        __weak typeof(self) weakSelf = self;
        [RelayActions draftTelegram:text done:^(NSString *state, NSString *detail) {
            [weakSelf reportAction:@"telegram" state:state detail:detail];
            if ([state isEqualToString:@"opened"]) { // a moment to read where the words are, then out of the way
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [weakSelf hideAnimated:YES]; });
            }
        }];
    } else if ([type isEqualToString:@"settle"]) {
        // The question was answered somewhere else, so the panel no longer needs to stay.
        self.pinned = NO;
        if (self.shown && ![self pointerIsNearPanel]) [self scheduleHide];
    }
}

// The answer to an app, typing or Telegram request, for the page to show.
- (void)reportAction:(NSString *)kind state:(NSString *)state detail:(NSString *)detail {
    [self callPage:@"if (window.relayAction) window.relayAction(kind, state, detail);"
         arguments:@{ @"kind": kind, @"state": state ?: @"", @"detail": detail ?: @"" }];
}

#pragma mark - RelayDictationDelegate

- (void)dictation:(RelayDictation *)dictation reports:(NSString *)state text:(NSString *)text error:(NSString *)error {
    if ([@[ @"done", @"cancelled", @"error" ] containsObject:state]) {
        self.wakeDictating = NO; // the microphone is free again
        [self updateWakePause];
    }
    [self callPage:@"if (window.relayDictation) window.relayDictation(state, text, error);"
         arguments:@{ @"state": state, @"text": text ?: @"", @"error": error ?: @"" }];
}

#pragma mark - RelayWakeDelegate

// The wake word listener waits while the microphone or the speakers are busy with something else.
- (void)updateWakePause {
    if (self.wakeDictating || self.wakeSpeaking) [self.wake pause];
    else [self.wake resume];
}

- (void)wake:(RelayWake *)wake reports:(NSString *)state text:(NSString *)text error:(NSString *)error {
    [self callPage:@"if (window.relayWake) window.relayWake(state, text, error);"
         arguments:@{ @"state": state, @"text": text ?: @"", @"error": error ?: @"" }];
}

#pragma mark - RelaySpeechDelegate

- (void)speech:(RelaySpeech *)speech reports:(NSString *)state {
    if ([state isEqualToString:@"start"]) self.wakeSpeaking = YES;
    else if ([state isEqualToString:@"end"] || [state isEqualToString:@"unavailable"]) self.wakeSpeaking = NO;
    [self updateWakePause];
    [self callPage:@"if (window.relaySpeech) window.relaySpeech(state);" arguments:@{ @"state": state }];
}

#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    BOOL local = [url.host isEqualToString:self.pageURL.host] && [url.port isEqualToNumber:self.pageURL.port];
    decisionHandler(local ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // The page may have been reloaded while open or while something was playing.
    if (self.shown) [self pushMode];
    if (self.nowPlaying.state) [self pushNowPlaying:self.nowPlaying.state];
    [self pushGlowStyle];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [webView reload];
}

@end
