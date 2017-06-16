const log4js = require('log4js');

const config = require('../config');
const apiError = require('../util/api-error');
const redisFactory = require('../util/redis-factory');
const namespace = require('../base/namespace');
const _util = require('../util/util');

const logger = log4js.getLogger('push');

const PUSH_MSG_ID_PREFIX = config.redis_push_msg_id_prefix;
const PUSH_MESSAGE_LIST_PREFIX = config.redis_push_message_list_prefix;
const PUSH_ACK_SET_PREFIX = config.redis_push_ack_set_prefix;
const PUSH_MSG_UUID = config.redis_push_msg_uuid;
const pushKList = 'namespace room except pushData apnsName leaveMessage';

const _redis = redisFactory.getInstance(true);
const homeBroadcastPub = redisFactory.getInstance();


exports.push = pushFn;



//*******************************************************************

/* 推送消息 */
async function pushFn(data) {

  //解析参数
  data = _util.pick(data, pushKList);

  if (!data.namespace) {
    apiError.throw('namespace can not be empty');
  } else if (!data.room) {
    apiError.throw('room can not be empty');
  } else if (!data.pushData || typeof data.pushData != 'object') {
    apiError.throw('pushData can not be empty and must be an Object');
  } else if (data.except && typeof data.except != 'string') {
    apiError.throw('except must be string');
  }

  //判断命名空间是否存在
  let nspConfig = namespace.data[data.namespace];
  if (!nspConfig) {
    apiError.throw('this namespace lose');
  }

  //判断apsData转化为JSON字符串后是否超过预定长度
  if (data.leaveMessage && data.pushData.apsData) {
    let apsDataStr;
    try {
      apsDataStr = JSON.stringify(data.pushData.apsData);
    } catch (e) {
      apiError.throw('parse pushData.apsData err' + e);
    }
    if (Buffer.byteLength(apsDataStr, 'utf-8') > config.apns_payload_size) {
      apiError.throw('pushData.apsData size must be less then ' + config.apns_payload_size + ' bytes');
    }
  }

  //初始化数据
  let nspAndRoom = data.namespace + '_' + data.room;
  let hsetKey = await _redis.incr(PUSH_MSG_UUID);
  data.id = hsetKey;
  data.sendDate = Date.now();
  data.ackCount = data.ackIOSCount = data.ackAndroidCount = data.onlineClientCount = 0;

  //存储消息
  await _redis.multi().hmset(PUSH_MSG_ID_PREFIX + hsetKey, Object.assign({}, data, { pushData: JSON.stringify(data.pushData) })).expire(PUSH_MSG_ID_PREFIX + hsetKey, config.push_message_h_expire).exec();
  //存储消息ID到系统消息ID列表中
  await _redis.multi().lpush(PUSH_MESSAGE_LIST_PREFIX + data.namespace, hsetKey).ltrim(PUSH_MESSAGE_LIST_PREFIX + data.namespace, 0, config.push_message_list_max_limit - 1).exec();
  //初始化确认消息回执的客户的集合
  let androidAckKey = PUSH_ACK_SET_PREFIX + 'android_{' + nspAndRoom + '}_' + hsetKey;
  await _redis.multi().sadd(androidAckKey, '__ack').expire(androidAckKey, config.push_message_h_expire).exec();
  let iosAckKey = PUSH_ACK_SET_PREFIX + 'ios_{' + nspAndRoom + '}_' + hsetKey;
  await _redis.multi().sadd(iosAckKey, '__ack').expire(iosAckKey, config.push_message_h_expire).exec();
  let webAckKey = PUSH_ACK_SET_PREFIX + 'web_{' + nspAndRoom + '}_' + hsetKey;
  await _redis.multi().sadd(webAckKey, '__ack').expire(webAckKey, config.push_message_h_expire).exec();
  //将推送消息放到消息队列中
  if (data.leaveMessage) {
    setTimeout(function () {
      _redis.lpush(config.redis_push_message_temp_list_prefix, hsetKey, function (err) {
        if (err) {
          logger.error('push message temp list err ' + err);
        }
      })
    }, config.worker_message_timeout);
  }

  //发布redis推送订阅频道
  let publishData = config.emit_msg_pick_key ? _util.pick(data, 'id namespace room pushData sendDate') : data;
  delete publishData.pushData.apsData;
  let chn = config.redis_home_broadcast_channel + '_' + data.namespace;
  let msg = JSON.stringify([publishData, {
    rooms: [data.room],
    except: data.except
  }]);
  homeBroadcastPub.publish(chn, msg);

  return { id: hsetKey };
}