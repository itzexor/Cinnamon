const Signals = imports.signals;
const Meta = imports.gi.Meta;


function SystrayManager() {
    this._init();
}

SystrayManager.prototype = {
    _init: function() {
        this._roles = [];
        this._emitId = 0;
    },
    
    queueEmitChanged: function() {
        if (this._emitId)
            return;

        this._emitId = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._emitId = 0;
            this.emit("changed");
        });
    },

    registerRole: function(role, id) {
        this._roles.push({role: role, id: id});
        this.queueEmitChanged();
    },
    
    unregisterRole: function(role, id) {
        for (let i = this._roles.length - 1; i >= 0; i--) {
            if (this._roles[i].id == id && this._roles[i].role == role) {
                this._roles.splice(i, 1);
            }
        }
        this.queueEmitChanged();
    },
    
    unregisterId: function(id) {
        for (let i = this._roles.length - 1; i >= 0; i--) {
            if (this._roles[i].id == id) {
                this._roles.splice(i, 1);
            }
        }
        this.queueEmitChanged();
    },
    
    getRoles: function(id) {
        let roles = [];
        for (let i = 0; i < this._roles.length; i++) {
            roles.push(this._roles[i].role);
        }
        
        return roles;
    }
}
Signals.addSignalMethods(SystrayManager.prototype);
