const closeShot = /特写|中近景|近景|近距离/u
const visibleFace = /面部|脸部|正脸|全脸|半张脸|面孔|正面|迎面|正对镜头|面对镜头/u
const visibleMouth = /嘴唇|嘴部|口部|唇部|唇形|口型/u
const mouthOutOfFrame = /(?:避开|不拍|不露|遮住|挡住).{0,8}(?:脸|嘴|口部|下半脸)|(?:嘴|口部|唇部|下半脸|脸部|面部).{0,8}(?:不入镜|不入画|在画框外|不在画面|被遮挡|看不到|不可见)/u
const isolatedDetail = /(?:只拍|仅拍|只取|仅取|只给|仅给).{0,12}(?:眼睛|眼部|双眼|手|肩背)|(?:眼部|双眼|瞳孔|手部|双手|肩背)特写/u
const invisibleAction = /(^|[，,；;。]\s*)(?:嘴唇(?:闭合|紧闭|不动)|喉结(?:轻动|微动))(?=[，,；;。]|$)/gu
const eyePerformance = /抬眼|垂眼|眼神|目光|瞳孔|眼皮|眉眼/u
const bodyPerformance = /手|抱拳|起身|转身|迈步|走|跑|跪|弯腰|衣袖|肩|道具/u

/** Reframe a confirmed, OS-only shot of its own speaker when the camera is on
 * their face. Keep the performance and story movement in the shot. */
export function scriptVideoOsFraming(camera: string, action: string): { camera: string; action: string } | undefined {
  if (mouthOutOfFrame.test(camera) || mouthOutOfFrame.test(action)) return
  const showsMouth = visibleMouth.test(camera)
  const showsFace = closeShot.test(camera) && visibleFace.test(camera) && !isolatedDetail.test(camera)
  if (!showsMouth && !showsFace) return

  const reframedAction = action.replace(invisibleAction, '').replace(/^[，,；;。]\s*/u, '').trim()
  const follows = /跟拍|跟随/u.test(camera)
  const movement = follows ? '侧后方跟拍' : '侧后方反应镜'
  const detail = !follows && eyePerformance.test(reframedAction) && !bodyPerformance.test(reframedAction)
    ? '局部特写｜取双眼与眉部'
    : `中近景｜${movement}｜画面取肩背与当前动作`
  return {
    camera: `${detail}，嘴部始终在画框外`,
    action: reframedAction || '人物停在原位，镜头保留肩背与当前姿势。',
  }
}
