// @flow
import getWeightDeltas from './getWeightDeltas'
import { ATATDEVALPHA, YYYY_MM_DD, TODAY_FEED, YYYYMMDDTHHmmss, NEUTRINO_SCORPION } from './Consts'
import { getMean, getCurrentWeights, getOrdersForWeightDeltas, getTotalValue } from './StrategyHelper'
import { HISTORICAL_FEED, REALTIME_FEED } from './devalpha'
import { getLoggableObject } from './LoggerHelper'
import invariant from 'fbjs/lib/invariant'
import mergeOrders from './mergeOrders'
import { getInstrument } from './NordnetInstruments'
import * as SlackHelper from './SlackHelper'

let LOGS = []
const log = (...args) => LOGS.push(args.join(', '))
const sendlog = () => SlackHelper.log(NEUTRINO_SCORPION, LOGS.join('\n'))
const getIsinFromIndexIdentifier = (identifier: string) => identifier.split('-')[1]
const DATE_FORMAT = YYYY_MM_DD
const TOLERANCE = 0.02
const WINDOW = 10
let PRICES: {[string]: Array<{timestamp: number, price: number}>} = {}

let NEW_WEIGHTS
export default (context: Context, action: StreamAction) => {
  let {type, payload} = action

  if (type.startsWith(ATATDEVALPHA)) return
  let _payload: ScorpionPayload = payload
  let {quotes, indices} = _payload
  let state = context.state()
  let totalValue = getTotalValue(state)
  let {timestamp, orders} = state
  let openOrders = Object.keys(orders).map(key => orders[key])

  const loggableAction = {...action, payload: {...action.payload, nordnetPriceFeedItems: undefined}}

  let currentWeights = getCurrentWeights(state)

  switch (type) {
    case HISTORICAL_FEED:
      log(type, JSON.stringify(getLoggableObject(state, {dateFormat: DATE_FORMAT})), JSON.stringify(getLoggableObject(loggableAction, {dateFormat: DATE_FORMAT})))
      invariant(indices, JSON.stringify(_payload))
      Object.keys(indices)
      .forEach(isin => {
        if (!PRICES[isin]) PRICES[isin] = []
        PRICES[isin].push({timestamp, price: indices[isin]})
        if (PRICES[isin].length > WINDOW) PRICES[isin].shift()
      })
      return
    case TODAY_FEED:
      log(type, JSON.stringify(getLoggableObject(state)), JSON.stringify(getLoggableObject(loggableAction, {dateFormat: YYYYMMDDTHHmmss})))
      invariant(indices, JSON.stringify(_payload))

      NEW_WEIGHTS = getNewWeights(currentWeights, indices)

      log(type, 'currentWeights', JSON.stringify(currentWeights))
      log(type, 'newWeights', JSON.stringify(NEW_WEIGHTS))
      return
    case REALTIME_FEED:
      log(type, JSON.stringify(getLoggableObject(state)), JSON.stringify(getLoggableObject(loggableAction, {dateFormat: YYYYMMDDTHHmmss})))
      invariant(NEW_WEIGHTS, '!newWeights')
      let weightDeltas: Array<WeightDelta> =
      getWeightDeltas(currentWeights, NEW_WEIGHTS)
      .map(wd => ({...wd, extra: {price: quotes[getIsinFromIndexIdentifier(wd.symbol)]}}))

      let newOrders =
      getOrdersForWeightDeltas(weightDeltas, totalValue)
      .map(o => ({...o, identifier: getIsinFromIndexIdentifier(o.identifier)}))

      let {toCreate, toAmmend, toCancel} = mergeOrders(newOrders, openOrders)

      toCreate.forEach(i => log(type, 'toCreate', JSON.stringify({name: getInstrument(i.identifier).name, ...i})))
      toAmmend.forEach(i => log(type, 'toAmmend', JSON.stringify({name: getInstrument(i.identifier).name, ...i})))
      toCancel.forEach(i => log(type, 'toCancel', JSON.stringify({name: getInstrument(i.identifier).name, ...i})))

      if (toCancel.length > 0) toCancel.forEach(o => context.cancel(o.id))
      else toCreate.concat(toAmmend).forEach(context.order)

      sendlog()
      return
    default: throw new Error(`Unknow tyoe: ${type}`)
  }
}

const getNewWeights = (currentWeights: Array<Weight>, indices: Quotes) =>
  Object.keys(indices)
  .map(name => ({name, price: indices[name]}))
  .map(({name, price}) => {
    let avg = getMean(PRICES[name].map(({price}) => price))
    let diff = (price - avg) / avg

    log('TODAY_FEED', 'name', name, 'avg', avg, 'price', price, 'diff', diff)
    let currentWeight = currentWeights.find(w => w.symbol === name) || {symbol: name, value: 0}

    switch (true) {
      case diff > TOLERANCE: return {...currentWeight, value: 1}
      case diff < -TOLERANCE: return {...currentWeight, value: 0}
      default: return currentWeight
    }
  })

export let filename = 'ScorpionStrategy'
