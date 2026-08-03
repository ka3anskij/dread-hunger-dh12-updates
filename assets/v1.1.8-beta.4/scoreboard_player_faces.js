'use strict';

(function () {
    var base = Module.findBaseAddress('DreadHunger-Win64-Shipping.exe');
    if (base === null) {
        return;
    }

    // Dread Hunger 1.2.4 / Hideout 1.1.8 Beta 4.
    var pregameAvatarInit = base.add(0xFCC3A0);
    var populateScoreboard = base.add(0xFC6550);
    var setScoreboardItemData = base.add(0xFE8950);
    var setBrushResourceObject = new NativeFunction(
        base.add(0x2457F10),
        'void',
        ['pointer', 'pointer']
    );

    var avatarByPlayerName = Object.create(null);
    var avatarOrder = [];
    var scoreboardIndex = 0;

    function readFString(address) {
        try {
            var data = address.readPointer();
            var length = address.add(8).readS32();
            if (data.isNull() || length <= 0 || length > 256) {
                return '';
            }
            return data.readUtf16String(length);
        } catch (_) {
            return '';
        }
    }

    function rememberAvatar(playerName, icon) {
        if (playerName.length === 0 || icon.isNull()) {
            return;
        }

        if (avatarByPlayerName[playerName] === undefined) {
            avatarOrder.push({ name: playerName, icon: icon });
        } else {
            for (var index = 0; index < avatarOrder.length; index++) {
                if (avatarOrder[index].name === playerName) {
                    avatarOrder[index].icon = icon;
                    break;
                }
            }
        }
        avatarByPlayerName[playerName] = icon;
    }

    // The pregame screen already receives the correct face portrait for every
    // player. Keep that texture together with the player name for the results.
    Interceptor.attach(pregameAvatarInit, {
        onEnter: function (args) {
            try {
                var data = args[1];
                if (data.isNull()) {
                    return;
                }
                rememberAvatar(readFString(data), data.add(0x10).readPointer());
            } catch (_) {
                // Leave the original UI untouched if the game data is incomplete.
            }
        }
    });

    // Each scoreboard refresh reuses its item widgets, so restart the ordered
    // fallback. The primary match remains the exact player name.
    Interceptor.attach(populateScoreboard, {
        onEnter: function () {
            scoreboardIndex = 0;
        }
    });

    Interceptor.attach(setScoreboardItemData, {
        onEnter: function (args) {
            this.item = args[0];
            this.icon = null;

            try {
                var record = args[1];
                if (this.item.isNull() || record.isNull()) {
                    return;
                }

                var playerName = readFString(record.add(0x30));
                var icon = avatarByPlayerName[playerName];
                if (icon === undefined && scoreboardIndex < avatarOrder.length) {
                    icon = avatarOrder[scoreboardIndex].icon;
                }
                scoreboardIndex++;

                if (icon !== undefined && !icon.isNull()) {
                    this.icon = icon;
                }
            } catch (_) {
                this.icon = null;
            }
        },
        onLeave: function () {
            if (this.icon === null) {
                return;
            }

            try {
                var view = this.item.add(0x278).readPointer();
                if (view.isNull()) {
                    return;
                }
                var playerImage = view.add(0x2C8).readPointer();
                if (playerImage.isNull()) {
                    return;
                }

                // Avatar and border are independent fields. Only replace the
                // picture; the explorer/thrall blue/red frame stays native.
                this.item.add(0x290).writePointer(this.icon);
                setBrushResourceObject(playerImage, this.icon);
            } catch (_) {
                // A failed cosmetic substitution must never break the scoreboard.
            }
        }
    });
})();
