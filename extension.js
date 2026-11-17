import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const {Urgency, NotificationDestroyedReason} = MessageTray;

const ANIMATION_TIME = MessageTray.ANIMATION_TIME;
const NOTIFICATION_TIMEOUT = 4000;
// Time left on a banner after the pointer leaves the stack or the user
// comes back from being idle.
const RESUME_TIMEOUT = 2000;
const IDLE_TIME = 1000;

const {START, CENTER, END} = Clutter.ActorAlign;
const POSITIONS = {
    'top-left': [START, START],
    'top-center': [CENTER, START],
    'top-right': [END, START],
    'bottom-left': [START, END],
    'bottom-center': [CENTER, END],
    'bottom-right': [END, END],
};

class BannerStack {
    constructor(settings) {
        this._settings = settings;
        this._entries = []; // oldest first
        this._userIdle = false;
        this._activeWatchId = 0;
        this._idleMonitor = global.backend.get_core_idle_monitor();

        this._container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this._container.add_constraint(new Layout.MonitorConstraint({
            primary: true,
            work_area: true,
        }));

        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
        });
        this._box.connect('notify::hover', () => this._onHoverChanged());
        this._container.add_child(this._box);

        Main.layoutManager.addChrome(this._container, {affectsInputRegion: false});
        Main.layoutManager.trackChrome(this._box, {affectsInputRegion: true});

        this._settings.connectObject(
            'changed::max-visible', () => this._trim(),
            'changed::position', () => this._applyPosition(),
            this);
        this._applyPosition();
    }

    get _isTop() {
        return this._settings.get_string('position').startsWith('top');
    }

    get _visibleEntries() {
        return this._entries.filter(e => !e.removing);
    }

    show(notification) {
        notification.acknowledged = true;
        notification.playSound();

        // An already visible notification was updated: refresh its timer.
        const existing = this._visibleEntries.find(e => e.notification === notification);
        if (existing) {
            this._startTimer(existing, NOTIFICATION_TIMEOUT);
            return;
        }

        const banner = new MessageList.NotificationMessage(notification);
        banner.can_focus = false;
        banner._header.expandButton.visible = false;
        banner.add_style_class_name('notification-banner');

        const entry = {notification, banner, timeoutId: 0, removing: false};

        // Run after the class handler, which destroys the notification
        // when the close button is clicked.
        banner.connectObject('close',
            () => this._remove(entry, {animate: false}),
            GObject.ConnectFlags.AFTER, this);
        // Expand on the first pointer motion, so a banner that pops up under
        // a resting pointer doesn't expand by itself.
        banner.connectObject('motion-event', () => {
            if (!banner.expanded)
                banner.expand(true);
            return Clutter.EVENT_PROPAGATE;
        }, this);

        if (this._entries.length === 0)
            global.compositor.disable_unredirect();

        this._entries.push(entry);
        if (this._isTop)
            this._box.insert_child_at_index(banner, 0);
        else
            this._box.add_child(banner);

        if (notification.urgency === Urgency.CRITICAL ||
            notification.source.policy.forceExpanded)
            banner.expand(false);

        banner.set_pivot_point(0.5, 0.5);
        banner.set({
            opacity: 0,
            translation_y: this._offscreenOffset(banner),
            scale_x: 0.9,
            scale_y: 0.9,
        });
        banner.ease({
            opacity: 255,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        banner.ease({
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        if (this._idleMonitor.get_idletime() > IDLE_TIME)
            this._waitForUserActive();

        this._startTimer(entry, NOTIFICATION_TIMEOUT);
        this._trim();
    }

    // Called whenever the tray re-evaluates its state.
    sync(tray) {
        // The tray blocks banners while a top bar menu covers them.
        this._container.visible = !(tray._bannerBlocked && this._isTop);

        if (!Main.sessionMode.hasNotifications) {
            this._visibleEntries.forEach(e => this._remove(e, {expired: true, animate: false}));
            return;
        }

        // Do Not Disturb turned on: hide everything that isn't critical.
        if (tray._busy) {
            this._visibleEntries
                .filter(e => e.notification.urgency !== Urgency.CRITICAL)
                .forEach(e => this._remove(e, {expired: true}));
        }
    }

    _trim() {
        const max = this._settings.get_int('max-visible');
        const visible = this._visibleEntries;
        const excess = visible.length - max;
        if (excess <= 0)
            return;

        // Drop the oldest banners, but keep critical ones (they never time
        // out) unless only critical banners are left.
        const isCritical = e => e.notification.urgency === Urgency.CRITICAL;
        const candidates = [
            ...visible.filter(e => !isCritical(e)),
            ...visible.filter(isCritical),
        ];
        candidates.slice(0, excess).forEach(e => this._remove(e, {expired: true}));
    }

    _applyPosition() {
        const [xAlign, yAlign] = POSITIONS[this._settings.get_string('position')] ??
            POSITIONS['top-center'];
        this._box.set({x_align: xAlign, y_align: yAlign});

        // Newest banner sits closest to the screen edge.
        const ordered = this._isTop ? [...this._entries].reverse() : this._entries;
        ordered.forEach((e, i) => this._box.set_child_at_index(e.banner, i));
    }

    _startTimer(entry, timeout) {
        this._clearTimer(entry);

        if (entry.notification.urgency === Urgency.CRITICAL)
            return;
        // Paused while the pointer is over the stack or the user is away.
        if (this._box.hover || this._userIdle)
            return;

        entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
            entry.timeoutId = 0;
            this._remove(entry, {expired: true});
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(entry.timeoutId,
            '[stacked-notifications] banner timeout');
    }

    _clearTimer(entry) {
        if (entry.timeoutId) {
            GLib.source_remove(entry.timeoutId);
            entry.timeoutId = 0;
        }
    }

    _resumeTimers() {
        this._visibleEntries.forEach(e => this._startTimer(e, RESUME_TIMEOUT));
    }

    _onHoverChanged() {
        if (this._box.hover)
            this._visibleEntries.forEach(e => this._clearTimer(e));
        else
            this._resumeTimers();
    }

    _waitForUserActive() {
        this._userIdle = true;
        if (this._activeWatchId)
            return;

        this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatchId = 0;
            this._userIdle = false;
            this._resumeTimers();
        });
    }

    _remove(entry, {expired = false, animate = true} = {}) {
        if (entry.removing)
            return;
        entry.removing = true;
        this._clearTimer(entry);

        const {banner} = entry;
        banner.remove_all_transitions();
        banner.reactive = false;

        const duration = animate ? ANIMATION_TIME : 0;
        banner.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        banner.ease({
            translation_y: this._offscreenOffset(banner),
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onStopped: () => this._finishRemove(entry, expired),
        });
    }

    _offscreenOffset(banner) {
        return this._isTop ? -banner.height : banner.height;
    }

    _finishRemove(entry, expired) {
        const index = this._entries.indexOf(entry);
        if (index === -1)
            return;
        this._entries.splice(index, 1);

        // banner.notification is null once the notification is destroyed.
        const notification = entry.banner.notification;
        entry.banner.destroy();

        // Like the stock tray: transient notifications go away once their
        // banner has been shown.
        if (expired && notification?.isTransient)
            notification.destroy(NotificationDestroyedReason.EXPIRED);

        if (this._entries.length === 0)
            global.compositor.enable_unredirect();
    }

    destroy() {
        this._settings.disconnectObject(this);

        if (this._activeWatchId) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }

        if (this._entries.length > 0)
            global.compositor.enable_unredirect();

        for (const entry of this._entries) {
            this._clearTimer(entry);
            entry.banner.remove_all_transitions();
            entry.banner.disconnectObject(this);
        }
        this._entries = [];

        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
    }
}

export default class StackedNotificationsExtension extends Extension {
    enable() {
        const tray = Main.messageTray;
        this._stack = new BannerStack(this.getSettings());

        this._savedMethods = new Map();
        const override = (name, impl) => {
            this._savedMethods.set(name,
                Object.getOwnPropertyDescriptor(tray, name));
            tray[name] = impl;
        };

        const stack = this._stack;
        const origUpdateState = tray._updateState;

        override('_showNotification', function () {
            // Hand over everything the tray would eventually show, while
            // respecting the same "busy / fullscreen" limits it applies.
            const limited = this._busy ||
                Main.layoutManager.primaryMonitor.inFullscreen;
            const ready = [], held = [];
            for (const n of this._notificationQueue) {
                const canShow = !limited || n.forFeedback ||
                    n.urgency === Urgency.CRITICAL;
                (canShow ? ready : held).push(n);
            }
            this._notificationQueue = held;
            this.emit('queue-changed');

            // Show in arrival order, but the most urgent last so it ends up
            // the newest banner. (sort() is stable, so ties keep their order.)
            ready.sort((a, b) => a.urgency - b.urgency)
                .forEach(n => stack.show(n));
        });

        override('_updateState', function (...args) {
            origUpdateState.apply(this, args);

            // If a stock banner (shown before we were enabled) was hidden
            // without animation, the tray's re-entrancy guard skips showing
            // the queue. Run one more pass so nothing gets stuck.
            if (this._notificationState === MessageTray.State.HIDDEN &&
                this._notificationQueue.length > 0)
                origUpdateState.apply(this, args);

            stack.sync(this);
        });

        // Pick up anything already waiting in the queue.
        tray._updateState();
    }

    disable() {
        const tray = Main.messageTray;
        for (const [name, descriptor] of this._savedMethods) {
            if (descriptor)
                Object.defineProperty(tray, name, descriptor);
            else
                delete tray[name];
        }
        this._savedMethods = null;

        this._stack.destroy();
        this._stack = null;
    }
}
