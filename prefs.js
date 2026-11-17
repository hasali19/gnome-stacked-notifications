import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = [
    ['top-left', 'Top left'],
    ['top-center', 'Top center'],
    ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'],
    ['bottom-center', 'Bottom center'],
    ['bottom-right', 'Bottom right'],
];

export default class StackedNotificationsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Notification Banners'});
        page.add(group);
        window.add(page);

        const maxRow = new Adw.SpinRow({
            title: 'Maximum visible notifications',
            subtitle: 'The oldest banner is hidden when a new one arrives and the limit is reached',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1}),
        });
        settings.bind('max-visible', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxRow);

        const positionRow = new Adw.ComboRow({
            title: 'Position',
            subtitle: 'Where on the screen notifications appear',
            model: Gtk.StringList.new(POSITIONS.map(([, label]) => label)),
        });
        const syncFromSettings = () => {
            const index = POSITIONS.findIndex(([id]) => id === settings.get_string('position'));
            positionRow.selected = Math.max(index, 0);
        };
        syncFromSettings();
        settings.connect('changed::position', syncFromSettings);
        positionRow.connect('notify::selected', () => {
            settings.set_string('position', POSITIONS[positionRow.selected][0]);
        });
        group.add(positionRow);
    }
}
