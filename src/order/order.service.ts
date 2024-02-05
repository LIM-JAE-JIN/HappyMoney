import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectEntityManager, InjectRepository } from "@nestjs/typeorm";
import { Order, OrderStatus } from "./entities/order.entity";
import { StockHolding } from "./entities/stockHolding.entity";
import { EntityManager, Repository } from "typeorm";
import { User } from "src/user/entities/user.entity";
import { CreateOrderDto } from "./dto/create-order.dto";
import { AccountsService } from "src/accounts/accounts.service";
import { Account } from "src/accounts/entities/account.entity";
import { PaginatePostDto } from "src/common/dto/paginate.dto";
import { Cron } from "@nestjs/schedule";

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(StockHolding)
    private readonly stockHoldingRepository: Repository<StockHolding>,
    private readonly accountsService: AccountsService,

    @InjectEntityManager()
    private readonly entityManager: EntityManager
  ) {}

  // 구매(매수)API
  async buyStock({ id }: User, { stockName, stockCode, orderNumbers, price, status }: CreateOrderDto) {
    const account = await this.accountsService.findOneAccount(id);

    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    // 매수 내역 생성
    const buyOrder = this.orderRepository.create({
      userId: id,
      accountId: account.id,
      stockName,
      stockCode,
      orderNumbers,
      price,
      ttlPrice: orderNumbers * price,
      buySell: true,
      status
    });

    /* 주식 구매(매수) 시 트랜잭션 s */
    await this.entityManager.transaction(async (em) => {
      try {
        // 구매(매수) 내역 저장
        await em.save(Order, buyOrder);

        // 계좌 포인트
        await em.update(
          Account,
          { id: account.id },
          {
            point: account.point - buyOrder.ttlPrice
          }
        );

        // 계좌에 해당 주식 확인
        const sH = await this.findOneStock(account.id, buyOrder.stockCode);

        // 계좌에 해당 주식이 없고 체결 됐을 때,
        if (!sH && buyOrder.status === OrderStatus.Complete) {
          const createSh = em.create(StockHolding, {
            userId: id,
            accountId: account.id,
            stockName,
            stockCode,
            numbers: buyOrder.orderNumbers,
            ttlPrice: buyOrder.ttlPrice
          });

          await em.save(StockHolding, createSh);
        }

        // 계좌에 해당 주식이 있고 체결 됐을 때,
        if (sH && buyOrder.status === OrderStatus.Complete) {
          await em.update(
            StockHolding,
            { accountId: buyOrder.accountId, stockCode: buyOrder.stockCode },
            {
              numbers: sH.numbers + buyOrder.orderNumbers,
              ttlPrice: sH.ttlPrice + buyOrder.ttlPrice
            }
          );
        }
      } catch (error) {
        console.error(error);
        throw error;
      }
    });
    /* 주식 구매(매수) 시 트랜잭션 e */
  }

  // 판매(매도)API
  async sellStock({ id }: User, { stockName, stockCode, orderNumbers, price, status }: CreateOrderDto) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    // 판매(매도) 내역 생성
    const sellOrder = this.orderRepository.create({
      userId: id,
      accountId: account.id,
      stockName,
      stockCode,
      orderNumbers,
      price,
      ttlPrice: orderNumbers * price,
      buySell: false,
      status
    });

    // 계좌에 해당 주식 확인
    const sH = await this.findOneStock(account.id, sellOrder.stockCode);
    if (!sH) throw new BadRequestException({ success: false, message: "주식을 보유하고 있지 않습니다" });
    if (sH.numbers < sellOrder.orderNumbers)
      throw new BadRequestException({ success: false, message: "보유한 주식보다 수량이 많습니다." });

    /* 주식 판매(매도) 시 트랜잭션 s */
    await this.entityManager.transaction(async (em) => {
      try {
        // 판매(매도) 내역 저장
        await em.save(Order, sellOrder);

        // 예약 매도 수량 확인
        const orderChk = await em.find(Order, {
          where: { accountId: account.id, buySell: false, stockCode: sH.stockCode, status: OrderStatus.Order }
        });
        const totalOrderNumbers = orderChk.reduce((total, order) => total + order.orderNumbers, 0);
        if (totalOrderNumbers > sH.numbers)
          throw new BadRequestException({ success: false, message: "보유 주식보다 예약 매수 수량이 많습니다." });

        // 체결 됐을 때,
        if (sH && sellOrder.status === OrderStatus.Complete) {
          // 계좌 포인트
          await em.update(
            Account,
            { id: account.id },
            {
              point: account.point + sellOrder.ttlPrice
            }
          );

          await em.update(
            StockHolding,
            { accountId: sellOrder.accountId, stockCode: sellOrder.stockCode },
            {
              numbers: sH.numbers - sellOrder.orderNumbers,
              ttlPrice: sH.ttlPrice - sellOrder.ttlPrice
            }
          );
        }
      } catch (error) {
        console.error(error);
        throw error;
      }
    });
    /* 주식 판매(매도) 시 트랜잭션 e */

    // 주식 보유수가 0일 때 보유 주식 데이터 삭제
    const updateStock = await this.findOneStock(account.id, sellOrder.stockCode);
    if (updateStock.numbers === 0) {
      await this.stockHoldingRepository.delete({ accountId: account.id, stockCode: sellOrder.stockCode });
    }
  }

  // 대기 매수 체결

  // 대기 매도 체결

  // 총 주문 내역API
  async getOrders({ id }: User, dto: PaginatePostDto) {
    const account = await this.accountsService.findOneAccount(id);

    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const [orders, total] = await this.orderRepository.findAndCount({
      where: { userId: id, accountId: account.id },
      skip: dto.take * (dto.page - 1),
      take: dto.take,
      order: {
        createdAt: dto.order__createdAt
      }
    });

    return {
      orders,
      total
    };
  }

  // 해당 주식 주문내역API
  async stockOrders(stockCode: string, { id }: User, dto: PaginatePostDto) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const [orders, total] = await this.orderRepository.findAndCount({
      where: { userId: id, accountId: account.id, stockCode },
      skip: dto.take * (dto.page - 1),
      take: dto.take,
      order: {
        createdAt: dto.order__createdAt
      }
    });

    return {
      orders,
      total
    };
  }

  // 주문 대기내역API
  async getWatingOrders({ id }: User) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const waitingLists = await this.orderRepository.find({
      where: { userId: id, accountId: account.id, status: OrderStatus.Order }
    });

    return waitingLists;
  }

  // 주문 대기 삭제
  // 월~금 오후 3시 30분 대기중인 주문 건 삭제
  @Cron("0 30 15 * * 1-5")
  async cleanupOrders() {
    try {
      await this.orderRepository.delete({ status: OrderStatus.Order });
      console.log("주문 대기 건 삭제완료");
      return {
        success: true,
        message: "체결되지 않은 주문 건이 삭제되었습니다."
      };
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }

  // 구매(매수) 대기내역 취소API
  async cancelBuyOrder(orderId: number, { id }: User) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const order = await this.orderRepository.findOne({
      where: { id: orderId, userId: id, accountId: account.id, status: OrderStatus.Order, buySell: true }
    });
    if (!order) throw new BadRequestException({ success: false, message: "주문을 찾을 수 없습니다." });

    await this.entityManager.transaction(async (em) => {
      try {
        order.status = OrderStatus.Cancel;
        await em.save(Order, order);

        // 계좌 포인트
        await em.update(
          Account,
          { id: account.id },
          {
            point: account.point + order.ttlPrice
          }
        );
      } catch (error) {
        console.error(error);
        throw error;
      }
    });

    return order;
  }

  // 판매(매도) 대기내역 취소API
  async cancelSellOrder(orderId: number, { id }: User) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const order = await this.orderRepository.findOne({
      where: { id: orderId, userId: id, accountId: account.id, status: OrderStatus.Order, buySell: false }
    });
    if (!order) throw new BadRequestException({ success: false, message: "주문을 찾을 수 없습니다." });

    order.status = OrderStatus.Cancel;
    await this.orderRepository.save(order);

    return order;
  }

  // 보유 주식 조회API
  async getStockHoldings({ id }: User) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const data = await this.stockHoldingRepository.find({ where: { userId: id, accountId: account.id } });

    return data;
  }

  // 해당 주식 조회API
  async getStockHolding(stockHoldingId: number, { id }: User) {
    const account = await this.accountsService.findOneAccount(id);
    if (!account) throw new BadRequestException({ success: false, message: "계좌를 생성해주세요." });

    const data = await this.stockHoldingRepository.findOne({
      where: { id: stockHoldingId, userId: id, accountId: account.id }
    });
    if (!data) throw new NotFoundException({ success: false, message: "해당 주식을 찾을 수 없습니다." });

    return data;
  }

  // 주식 확인
  async findOneStock(accountId: number, stockCode: string) {
    return await this.stockHoldingRepository.findOne({
      where: { accountId: accountId, stockCode: stockCode }
    });
  }
}
