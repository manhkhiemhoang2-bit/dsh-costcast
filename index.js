/**
 * Host half of the dsh-costcast bundle.
 *
 * 宿主半端不参与计算：成本预估需要的数据都在浏览器侧的投影里
 * （tokenUsage / sessionStats / contextPressure），客户端模块自己读得到。
 * 因此不需要读会话文件、不需要轮询、不申请额外权限。
 *
 * 这个文件存在只是因为 bundle 的行需要一个宿主入口。
 */
export function apply() {}
