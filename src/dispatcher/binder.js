// @flow
/**
 * A class to mark all the events name of certain kind of part
 * It can use to rebind the events
 */

import Bus from './bus';
import { videoEvents, domEvents, kernelEvents, passiveEvents, esFullscreenEvents, mustListenVideoDomEvents } from 'helper/const';
import { camelize, Log, isString, addEvent, removeEvent, isEmpty, isFunction } from 'chimee-helper';
import { before, runnable } from 'toxic-decorators';
import Dispatcher from './index';

const secondaryReg = /^(before|after|_)/;

/**
 * In logic before 0.10.0, we use 'c_' and 'w_' to mark event of container and wrapper
 * we need to keep that logic work until next major version.
 * @param {string} name 事件名字
 */
function getEventTargetByOldLogic(oldName: string): { name: string, target: binderTarget } | false {
  const targetKeyReg = new RegExp('^(c|w)_');
  const matches = oldName.match(targetKeyReg);
  if (matches) {
    const name = oldName.replace(targetKeyReg, '');
    const target = oldName.indexOf('c') === 0
      ? 'container'
      : 'wrapper';
    /* istanbul ignore else  */
    if (process.env.NODE_ENV !== 'production') {
      Log.warn(`We no longer support event names like ${oldName}. Please use ${name} and options like { target: '${target}' } instead`);
    }
    return { name, target };
  } else if (oldName === 'error') {
    return { name: 'error', target: 'kernel' };
  }
  return false;
}

function getEventStage(name: string): { stage: eventStage, name: string } {
  const matches = name.match(secondaryReg);
  // $FlowFixMe: We make sure it's event stage here
  const stage: eventStage = (matches && matches[0]) || 'main';
  if (matches) {
    name = camelize(name.replace(secondaryReg, ''));
  }
  return { name, stage };
}

function getEventTargetByEventName(name: string): binderTarget {
  if (videoEvents.indexOf(name) > -1) return 'video';
  if (kernelEvents.indexOf(name) > -1) return 'kernel';
  if (domEvents.indexOf(name) > -1) return 'video-dom';
  if (esFullscreenEvents.indexOf(name) > -1) return 'esFullscreen';
  return 'plugin';
}

function getEventInfo({ name, target, stage }: rawEventInfo): additionalEventInfo {
  const oldInfo = getEventTargetByOldLogic(name);
  if (oldInfo) {
    name = oldInfo.name;
    target = oldInfo.target;
  }
  const { stage: newStage, name: newName } = getEventStage(name);
  name = newName;

  if (!target) {
    target = getEventTargetByEventName(name);
  }

  return {
    name,
    stage: stage || newStage,
    target,
  };
}

function prettifyEventParameter(info: rawEventInfo): wholeEventInfo {
  const { id, fn } = info;
  const { name, target, stage } = getEventInfo(info);
  if (!isFunction(fn)) {
    throw new Error(`You must provide a function to handle with event ${name}, but not ${typeof fn}`);
  }
  return {
    id,
    fn,
    name,
    target,
    stage,
  };
}

function isEventEmitalbe({
  id,
  name,
}: emitEventInfo): boolean {
  if (!name || !isString(name) || secondaryReg.test(name)) {
    Log.error('You must provide a legal event name, which is string and could not started with before/after/_');
    return false;
  }
  if (!id || !isString(id)) {
    Log.error('You must provide the id of emitter');
    return false;
  }
  return true;
}

function checkEventEmitParameter(info: emitEventInfo, ...args: any[]): Array<emitEventInfo | any[]> {
  // $FlowFixMe: the info match requirement here
  info.target = getEventInfo(info).target;
  return [ info, ...args ];
}

export default class Binder {
  kinds: binderTarget[];
  bindedEventNames: { [binderTarget]: string[] };
  bindedEventInfo: { [binderTarget]: Array<[string, Function]> };
  buses: { [binderTarget]: Bus };
  pendingEventsInfo: { [binderTarget]: Array<[string, string]> };
  __dispatcher: Dispatcher;

  constructor(dispatcher: Dispatcher) {
    this.__dispatcher = dispatcher;
    this.kinds = [
      'kernel',
      'container',
      'wrapper',
      'video',
      'video-dom',
      'plugin',
      'esFullscreen',
    ];
    this.buses = {};
    this.bindedEventNames = {};
    this.bindedEventInfo = {};
    this.pendingEventsInfo = {};
    for (const kind of this.kinds) {
      this.bindedEventNames[kind] = [];
      this.bindedEventInfo[kind] = [];
      this.pendingEventsInfo[kind] = [];
      this.buses[kind] = new Bus(dispatcher, kind);
    }
  }

  @before(prettifyEventParameter)
  on({
    target,
    id,
    name,
    fn,
    stage,
  }: wholeEventInfo) {
    this._addEventListenerOnTarget({
      name,
      target,
      id,
    });
    return this.buses[target].on(id, name, fn, stage);
  }

  @before(prettifyEventParameter)
  off({
    target,
    id,
    name,
    fn,
    stage,
  }: wholeEventInfo) {
    const ret = this.buses[target].off(id, name, fn, stage);
    this._removeEventListenerOnTargetWhenIsUseless({ name, target });
    return ret;
  }

  @before(prettifyEventParameter)
  once({
    target,
    id,
    name,
    fn,
    stage,
  }: wholeEventInfo) {
    return this.buses[target].once(id, name, fn, stage);
  }

  @runnable(isEventEmitalbe)
  @before(checkEventEmitParameter)
  emit({
    target,
    name,
    // id,
  }: emitEventInfo, ...args: any[]) {
    return this.buses[target].emit(name, ...args);
  }

  @runnable(isEventEmitalbe, { backup() { return false; } })
  @before(checkEventEmitParameter)
  emitSync({
    target,
    name,
    // id,
  }: emitEventInfo, ...args: any[]) {
    return this.buses[target].emitSync(name, ...args);
  }

  @runnable(isEventEmitalbe)
  @before(checkEventEmitParameter)
  trigger({
    target,
    name,
    // id,
  }: emitEventInfo, ...args: any[]) {
    return this.buses[target].trigger(name, ...args);
  }

  @runnable(isEventEmitalbe, { backup() { return false; } })
  @before(checkEventEmitParameter)
  triggerSync({
    target,
    name,
    // id,
  }: emitEventInfo, ...args: any[]) {
    return this.buses[target].triggerSync(name, ...args);
  }

  // when we create a penetrate plugin, we need to rebind video events on it
  bindEventOnPenetrateNode(node: Element, remove: boolean = false) {
    this.bindedEventInfo['video-dom']
      .forEach(([ name, fn ]) => {
        remove
          ? removeEvent(node, name, fn)
          : this._addEventOnDom(node, name, fn);
      });
  }

  // when we switch kernel, we will create a new video.
  // we need to transfer the event from the oldvideo to it.
  bindEventOnVideo(node: Element, remove: boolean = false) {
    this.bindedEventInfo['video-dom']
      .concat(this.bindedEventInfo.video)
      .forEach(([ name, fn ]) => {
        remove
          ? removeEvent(node, name, fn)
          : this._addEventOnDom(node, name, fn);
      });
  }

  // As penetrate plugin is considered to be part of video
  // we need to transfer event for it
  // so we need some specail event handler
  listenOnMouseMoveEvent(node: Element) {
    const dom = this.__dispatcher.dom;
    const target = 'video-dom';
    const id = '_vm';
    mustListenVideoDomEvents.forEach(name => {
      const fn = (...args) => {
        const { toElement, currentTarget, relatedTarget, type } = args[0];
        const to = toElement || relatedTarget;
        // As we support penetrate plugin, the video dom event may be differnet.
        if (dom.mouseInVideo && type === 'mouseleave' && !dom.isNodeInsideVideo(to)) {
          dom.mouseInVideo = false;
          return this.triggerSync({
            target,
            name,
            id,
          }, ...args);
        }
        if (!dom.mouseInVideo && type === 'mouseenter' && dom.isNodeInsideVideo(currentTarget)) {
          dom.mouseInVideo = true;
          return this.triggerSync({
            target,
            name,
            id,
          }, ...args);
        }
      };
      this._addEventOnDom(node, name, fn);
      // this function is only used once now
      // so we do not cover this branch
      // but we still keep this judegement
      /* istanbul ignore else  */
      if (this.bindedEventNames[target].indexOf(name) < 0) {
        this.bindedEventNames[target].push(name);
        // $FlowFixMe: fn must be function now
        this.bindedEventInfo[target].push([ name, fn ]);
      }
    });
  }

  // When we switch kernel, we need to rebind the events
  migrateKernelEvent(oldKernel: ChimeeKernel, newKernel: ChimeeKernel) {
    const bindedEventInfoList = this.bindedEventInfo.kernel;
    bindedEventInfoList.forEach(([ name, fn ]) => {
      oldKernel.off(name, fn);
      newKernel.on(name, fn);
    });
  }

  // when we destroy, we remove all binder
  destroy() {
    this.kinds.forEach(target => {
      if (target === 'kernel') {
        this.bindedEventInfo.kernel.forEach(([ name, fn ]) => {
          this.__dispatcher.kernel.off(name, fn);
        });
      } else {
        const targetDom = this._getTargetDom(target);
        this.bindedEventInfo[target].forEach(([ name, fn ]) => {
          removeEvent(targetDom, name, fn);

          if (target === 'video-dom') {
            this.__dispatcher.dom.videoExtendedNodes.forEach(node => removeEvent(node, name, fn));
          }
        });
      }
      this.bindedEventInfo.kernel = [];
      this.bindedEventNames.kernel = [];
    });
  }

  _addEventOnDom(element: Element, key: string, fn: Function) {
    if (passiveEvents.indexOf(key) > -1) {
      return addEvent(element, key, fn, false, { passive: true });
    }
    addEvent(element, key, fn);
  }

  // Some event needs us to transfer it from the real target
  // such as dom event
  _addEventListenerOnTarget({
    name,
    target,
    id,
  }: {
    name: string,
    target: binderTarget,
    id: string,
  }) {
    if (!this._isEventNeedToBeHandled(target, name)) return;
    let fn;
    // if this event has been binded, return;
    if (this.bindedEventNames[target].indexOf(name) > -1) return;
    const targetDom = this._getTargetDom(target);
    // choose the correspond method to bind
    if (target === 'kernel') {
      if (!this.__dispatcher.kernel) {
        this.addPendingEvent(target, name, id);
        return;
      }
      fn = (...args) => this.triggerSync({ target, name, id: 'kernel' }, ...args);
      this.__dispatcher.kernel.on(name, fn);
    } else if (target === 'container' || target === 'wrapper') {
      fn = (...args) => this.triggerSync({ target, name, id: target }, ...args);
      this._addEventOnDom(targetDom, name, fn);
    } else if (target === 'video') {
      fn = (...args) => this.trigger({ target, name, id: target }, ...args);
      this._addEventOnDom(targetDom, name, fn);
    } else if (target === 'video-dom') {
      fn = (...args) => this.triggerSync({ target, name, id: target }, ...args);
      this.__dispatcher.dom.videoExtendedNodes.forEach(node => this._addEventOnDom(node, name, fn));
      this._addEventOnDom(targetDom, name, fn);
    }
    this.bindedEventNames[target].push(name);
    // $FlowFixMe: fn must be function now
    this.bindedEventInfo[target].push([ name, fn ]);
  }

  // when we off one event, we can remove the useless binder
  // actually we should remove on once event too
  // but it seems ugliy
  // TODO: add this function on once event too
  _removeEventListenerOnTargetWhenIsUseless({
    name,
    target,
  }: {
    name: string,
    target: binderTarget,
  }) {
    if (!this._isEventNeedToBeHandled(target, name)) return;
    const eventNamesList = this.bindedEventNames[target];
    const nameIndex = eventNamesList.indexOf(name);
    // if we have not bind this event before, we omit it
    if (nameIndex < 0) return;
    // if the buses still have another function on bind, we do not need to remove the binder
    if (!isEmpty(this.buses[target].events[name])) return;

    // we fetch the binded function from bindedEventInfo
    const bindedEventInfoList = this.bindedEventInfo[target];
    let fn;
    let index;
    for (index = 0; index < bindedEventInfoList.length; index++) {
      if (bindedEventInfoList[index][0] === name) {
        fn = bindedEventInfoList[index][1];
        break;
      }
    }
    if (!isFunction(fn)) return;

    if (target === 'kernel') {
      this.__dispatcher.kernel.off(name, fn);
    } else {
      const targetDom = this._getTargetDom(target);

      removeEvent(targetDom, name, fn);

      // When we remove something on video dom, we also need to remove event on penetrate plugin
      if (target === 'video-dom') {
        this.__dispatcher.dom.videoExtendedNodes.forEach(node => {
          // $FlowFixMe: fn is function now
          removeEvent(node, name, fn);
        });
      }
    }

    bindedEventInfoList.splice(index, 1);
    eventNamesList.splice(nameIndex, 1);
  }

  _getTargetDom(target: binderTarget): Element {
    let targetDom;
    switch (target) {
      case 'container':
      case 'wrapper':
        // $FlowFixMe: fix dom index bug
        targetDom = this.__dispatcher.dom[target];
        break;
      default:
        targetDom = this.__dispatcher.dom.videoElement;
        break;
    }
    return targetDom;
  }

  _isEventNeedToBeHandled(target: binderTarget, name: string): boolean {
    // the plugin target do not need us to transfer
    // we have listened on esFullscreen in dom
    // we have listened mustListenVideoDomEvents
    // so the events above do not need to rebind
    return target !== 'plugin' &&
      target !== 'esFullscreen' &&
      (mustListenVideoDomEvents.indexOf(name) < 0 || target !== 'video');
  }

  addPendingEvent(target: binderTarget, name: string, id: string) {
    this.pendingEventsInfo[target].push([ name, id ]);
  }

  applyPendingEvents(target: binderTarget) {
    const pendingEvents = this.pendingEventsInfo[target];
    const pendingEventsCopy = pendingEvents.splice(0, pendingEvents.length);
    while (pendingEventsCopy.length) {
      const [ name, id ] = pendingEventsCopy.pop();
      this._addEventListenerOnTarget({ name, target, id });
    }
  }
}
