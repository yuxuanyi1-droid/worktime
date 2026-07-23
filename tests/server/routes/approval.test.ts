import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ApprovalService } from '@server/services/approvalService';
import { AuditService } from '@server/services/auditService';
import { AppDataSource } from '@server/config/database';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 12, username: 'approver', realName: '审批人', roles: ['employee'] };
    req.userPermissions = new Set([
      'approval:view:todo',
      'approval:view:done',
      'approval:approve:assigned',
      'approval:withdraw:self',
      'approval:view:cc',
    ]);
    next();
  },
}));

const { approvalRoutes } = await import('@server/routes/approval');
const app = createRouteTestApp('/approvals', approvalRoutes);

describe('审批路由契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService.prototype, 'log').mockResolvedValue(undefined);
  });

  it('我的申请校验筛选条件并传递服务端分页', async () => {
    const service = vi.spyOn(ApprovalService.prototype, 'getMySubmissions').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 20,
    });
    const response = await request(app).get('/approvals/my-submissions?targetType=weekly_report&status=withdrawn&page=2');

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(12, expect.objectContaining({
      targetType: 'weekly_report', status: 'withdrawn', page: 2, pageSize: 20,
    }));
  });

  it('拒绝未知审批类型，且不会调用业务服务', async () => {
    const service = vi.spyOn(ApprovalService.prototype, 'getApprovalDetail');
    const response = await request(app).get('/approvals/detail/unknown/1');

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('targetType');
    expect(service).not.toHaveBeenCalled();
  });

  it('审批批次限制为 1 到 100 条并限制意见长度', async () => {
    const service = vi.spyOn(ApprovalService.prototype, 'approve');
    const emptyResponse = await request(app).post('/approvals/approve').send({ items: [] });
    expect(emptyResponse.status).toBe(400);

    const longCommentResponse = await request(app).post('/approvals/approve').send({
      items: [{ targetType: 'timesheet', targetId: 1, action: 'reject', comment: 'x'.repeat(1001) }],
    });
    expect(longCommentResponse.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('审批详情把当前登录用户传入对象级授权校验', async () => {
    const service = vi.spyOn(ApprovalService.prototype, 'getApprovalDetail').mockResolvedValue({
      content: {}, flowSteps: [], records: [], viewerContext: {},
    } as any);
    const response = await request(app).get('/approvals/detail/timesheet/9');

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith('timesheet', 9, 12);
  });

  it('待办、已办和抄送列表锁定当前审批人并规范化分页', async () => {
    const pending = vi.spyOn(ApprovalService.prototype, 'getPendingList').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 10,
    } as any);
    const history = vi.spyOn(ApprovalService.prototype, 'getApprovalHistory').mockResolvedValue({
      list: [], total: 0, page: 1, pageSize: 20,
    } as any);
    const cc = vi.spyOn(ApprovalService.prototype, 'getMyCcList').mockResolvedValue({
      list: [], total: 0, page: 3, pageSize: 5,
    } as any);

    expect((await request(app).get('/approvals/pending?targetType=overtime&page=2&pageSize=10')).status).toBe(200);
    expect(pending).toHaveBeenCalledWith(12, { targetType: 'overtime', page: 2, pageSize: 10 });

    expect((await request(app).get('/approvals/history?mine=false&targetId=7')).status).toBe(200);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ viewerId: 12, targetId: 7 }));
    expect(history.mock.calls[0][0]).not.toHaveProperty('mine');

    expect((await request(app).get('/approvals/my-cc?page=3&pageSize=5')).status).toBe(200);
    expect(cc).toHaveBeenCalledWith(12, { page: 3, pageSize: 5 });
  });

  it('批量审批调用服务并逐条记录审计', async () => {
    const approve = vi.spyOn(ApprovalService.prototype, 'approve').mockResolvedValue([{ success: true }] as any);
    const response = await request(app).post('/approvals/approve').send({
      items: [
        { targetType: 'timesheet', targetId: 3, action: 'approve', comment: '通过' },
        { targetType: 'overtime', targetId: 4, action: 'reject', comment: '补充原因' },
      ],
    });
    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(12, '审批人', expect.arrayContaining([
      expect.objectContaining({ targetType: 'timesheet', targetId: 3, action: 'approve' }),
      expect.objectContaining({ targetType: 'overtime', targetId: 4, action: 'reject' }),
    ]));
    expect(AuditService.prototype.log).toHaveBeenCalledTimes(2);
  });

  it('撤回和抄送只传入当前申请人，并保留收件人顺序', async () => {
    const withdraw = vi.spyOn(ApprovalService.prototype, 'withdraw').mockResolvedValue({ id: 2 } as any);
    const cc = vi.spyOn(ApprovalService.prototype, 'cc').mockResolvedValue({ sent: 2 } as any);

    expect((await request(app).post('/approvals/withdraw').send({
      targetType: 'weekly_report', targetId: 2,
    })).status).toBe(200);
    expect(withdraw).toHaveBeenCalledWith(12, 'weekly_report', 2);

    expect((await request(app).post('/approvals/cc').send({
      targetType: 'timesheet', targetId: 3, recipientIds: [8, 9],
    })).status).toBe(200);
    expect(cc).toHaveBeenCalledWith(12, '审批人', 'timesheet', 3, [8, 9]);
  });

  it('抄送候选人只返回启用的其他用户并隐藏账号字段', async () => {
    const find = vi.fn().mockResolvedValue([{
      id: 8, realName: '接收人', username: 'hidden', password: 'secret',
      department: { id: 2, name: '研发部', description: '内部' },
    }]);
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({ find } as any);
    const response = await request(app).get('/approvals/users');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 8, realName: '接收人', department: '研发部' }]);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      select: ['id', 'realName', 'department'],
    }));
  });
});
